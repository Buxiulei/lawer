// app/src/lib/auth/realname.ts
// 实人认证（阿里云 CloudAuth H5 活体）。语义移植自
// /home/roots/NBDpsy/后端服务/管理后端/src/services/cloudauth.rs（spec §3.3 抄优于写）。
//
// 分两层：
//   裸客户端  initFaceVerify / describeFaceVerify —— 只管把阿里云 API 调对，不认识数据库
//   编排      startRealname / refreshRealnameStatus —— 落流水、回填 users、判幂等
//
// 【隐私铁律】姓名与身份证号全程只以密文形态落库：
//   - realname_verifications.raw_meta_enc 存 {cert_name, cert_no, result} 的密文信封，
//     争议时可回溯"我们当时拿什么去核的、阿里云回了什么"（spec §7 该列的定义）。
//   - cert_no 列存的是**阿里云认证流水号 CertifyId**，不是身份证号——身份证号属敏感字段，
//     不得有明文列（spec §10）。轮询要靠它找回这次认证，故必须是明文可查的标识。
//   - 通过后姓名/证件号再各自加密回填 users.real_name_enc / id_card_enc。
//
// 阿里云不回调、只能轮询（NBDpsy 同款做法）：H5 认证页跑在用户手机上，
// 完成后跳回 ReturnUrl，前端再打 GET /api/v1/realname/status 让服务端去 Describe。
import type { Database } from 'better-sqlite3';

import { decryptField, encryptField } from '@/lib/crypto';
import { buildSignedRpcUrl, type FetchImpl } from '@/lib/notify';
import { CERT_TYPE } from '@/lib/evidence/attest';
import * as store from '@/lib/db/realname';
import * as users from '@/lib/db/otp';
import type { AuthFailure } from './otp';

const CLOUDAUTH_VERSION = '2019-03-07';
const PROVIDER = 'cloudauth';

/** users.auth_status 的三态（与 migrate.ts users.auth_status 注释逐字对齐） */
export const AUTH_STATUS = {
  none: '未认证',
  pending: '待审',
  verified: '已实名',
} as const;

/**
 * realname_verifications.status 的取值。
 * 用「未通过」而不是把用户打回「未认证」：流水是只追加的核验史，
 * 失败这件事本身要留得下（users.auth_status 才是当前结论的物化缓存）。
 */
/** 护照通道的 provider 值。放这里而不是 passport-realname.ts：那边 import 本文件，反过来会成环。 */
export const PASSPORT_PROVIDER = 'passport';

export const VERIFICATION_STATUS = {
  pending: '待审',
  passed: '已实名',
  failed: '未通过',
} as const;

// ========== 裸客户端 ==========

interface CloudauthConfig {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  sceneId: string;
  productCode: string;
  model: string;
  returnUrlBase: string;
}

function getConfig(): CloudauthConfig {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const sceneId = process.env.CLOUDAUTH_SCENE_ID;
  const productCode = process.env.CLOUDAUTH_PRODUCT_CODE;
  const model = process.env.CLOUDAUTH_MODEL;
  const returnUrlBase = process.env.CLOUDAUTH_RETURN_URL_BASE;
  if (!accessKeyId || !accessKeySecret || !sceneId || !productCode || !model || !returnUrlBase) {
    throw new Error('阿里云实人认证凭证未配置');
  }
  return {
    accessKeyId,
    accessKeySecret,
    region: process.env.ALIYUN_REGION ?? 'cn-hangzhou',
    sceneId,
    productCode,
    model,
    returnUrlBase,
  };
}

/** 阿里云 cloudauth 是分区域域名，与短信的单域名不同 */
function endpoint(region: string): string {
  return `https://cloudauth.${region}.aliyuncs.com`;
}

async function callApi(
  action: string,
  params: Record<string, string>,
  fetchImpl: FetchImpl,
): Promise<Record<string, unknown>> {
  const config = getConfig();
  const url = buildSignedRpcUrl({
    endpoint: endpoint(config.region),
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    // cloudauth 用 SHA256，短信用 SHA1——同一套协议的两种摘要，别抄串
    signatureMethod: 'HMAC-SHA256',
    params: { Action: action, Version: CLOUDAUTH_VERSION, ...params },
  });

  const res = await fetchImpl(url, { method: 'GET' });
  const data = (await res.json()) as Record<string, unknown>;
  // 短信成功码是 "OK"，实人认证是 "200"——两个产品线不一致，故各自判各自的
  if (data.Code !== '200') {
    throw new Error(typeof data.Message === 'string' ? data.Message : '实人认证接口调用失败');
  }
  return data;
}

function resultObject(data: Record<string, unknown>): Record<string, unknown> {
  const obj = data.ResultObject;
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

export interface InitFaceVerifyResult {
  certifyId: string;
  /**
   * H5 认证页 URL。按 SceneId 在控制台绑定的接入类型返回：
   * 绑成 APP/SDK 接入（如 ProductCode=ID_PRO）时阿里云只回 CertifyId、不回 CertifyUrl，
   * 此时为 null——不当作错误抛，让调用方能把"控制台配置不对"这件事说清楚。
   */
  certifyUrl: string | null;
}

/** 发起实人认证。cert_name/cert_no 是明文姓名与身份证号，只在本次请求里出现，不落明文。 */
export async function initFaceVerify(
  input: { userId: number; certName: string; certNo: string; returnUrl: string; metaInfo?: string },
  fetchImpl: FetchImpl = fetch,
): Promise<InitFaceVerifyResult> {
  const config = getConfig();
  const data = await callApi(
    'InitFaceVerify',
    {
      SceneId: config.sceneId,
      OuterOrderNo: `user_${input.userId}`,
      ProductCode: config.productCode,
      Model: config.model,
      CertType: 'IDENTITY_CARD',
      CertName: input.certName,
      CertNo: input.certNo,
      ReturnUrl: input.returnUrl,
      // MetaInfo 是端上采集的设备信息，H5 方案必填；前端没传就给最小可用值
      MetaInfo: input.metaInfo ?? '{"deviceType":"web"}',
      CertifyUrlStyle: 'L',
      // UserId：PV_FV / LR_FR 等 H5 活体方案必填（阿里云用它做风控关联），ID_PRO 可不传，统一传
      UserId: String(input.userId),
    },
    fetchImpl,
  );

  const result = resultObject(data);
  const certifyId = str(result, 'CertifyId');
  if (!certifyId) throw new Error('实人认证响应缺少 CertifyId');
  return { certifyId, certifyUrl: str(result, 'CertifyUrl') };
}

export interface DescribeFaceVerifyResult {
  passed: boolean;
  subCode: string;
  message: string;
  /**
   * 阿里云 ResultObject.Passed 原始值：'T'=通过 / 'F'=失败 / null=尚无结果（用户还没做完）。
   * 阿里云官方：判断认证结果以 Passed 为准——比 SubCode 白名单可靠。
   */
  passedRaw: string | null;
  /** 原始响应，加密留档用（争议时要能回溯） */
  raw: Record<string, unknown>;
}

const SUB_CODE_MESSAGES: Record<string, string> = {
  '200': '认证通过',
  '201': '姓名和身份证号不一致',
  '202': '人脸和身份证照片不一致',
  '203': '活体检测失败',
  Z1003: '用户取消认证',
};

/** 查询认证结果。用户没做完时 passedRaw 为 null，调用方据此判"还在进行中"。 */
export async function describeFaceVerify(
  certifyId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<DescribeFaceVerifyResult> {
  const config = getConfig();
  const data = await callApi(
    'DescribeFaceVerify',
    { SceneId: config.sceneId, CertifyId: certifyId },
    fetchImpl,
  );

  const result = resultObject(data);
  const passedRaw = str(result, 'Passed');
  const passed = passedRaw === 'T';
  const subCode = str(result, 'SubCode') ?? '';
  const message = SUB_CODE_MESSAGES[subCode] ?? (passed ? '认证通过' : `认证未通过：${subCode}`);
  return { passed, subCode, message, passedRaw, raw: data };
}

// ========== 编排 ==========

/** 外部副作用注入点：单测把阿里云换成假实现，绝不真发（真活体认证要真人脸） */
export interface RealnameDeps {
  init?: typeof initFaceVerify;
  describe?: typeof describeFaceVerify;
}

export type StartRealnameResult =
  | { ok: true; verificationId: number; certifyId: string; certifyUrl: string | null }
  | AuthFailure;

export type RealnameStatusResult =
  | {
      ok: true;
      /** users.auth_status 的当前值 */
      authStatus: string;
      /** realname_verifications 最新一行的 status；从未发起过认证时为 null */
      verificationStatus: string | null;
      /** 走的哪条通道（provider）：cloudauth | passport；从未发起过为 null。
       *  前端与 lawer 按同一形状读两条路，判据不分叉。 */
      method: string | null;
      message: string;
    }
  | AuthFailure;

function fail(status: number, errorCode: string, message: string): AuthFailure {
  return { ok: false, status, errorCode, message };
}

/** 大陆二代身份证：17 位数字 + 校验位（数字或 X）。只做形状校验，真伪交给阿里云。 */
function isIdCard(value: string): boolean {
  return /^\d{17}[\dXx]$/.test(value);
}

/** 加密信封：姓名证件号在这里存一份，通过时据此回填 users，失败时留作核验凭据 */
interface MetaEnvelope {
  cert_name: string;
  cert_no: string;
  result?: unknown;
}

/** 解不开（密钥换过、密文被改、格式不认识）一律返回 null，由调用方当"流水已损坏"处理 */
function readEnvelope(rawMetaEnc: string | null): MetaEnvelope | null {
  if (!rawMetaEnc) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptField(rawMetaEnc));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Partial<MetaEnvelope>;
  return typeof env.cert_name === 'string' && typeof env.cert_no === 'string'
    ? { cert_name: env.cert_name, cert_no: env.cert_no, result: env.result }
    : null;
}

/**
 * 护照被驳回时，把审核人写下的**原因原文**取出来当 message。
 *
 * 【为什么不是硬编码的"认证未通过"】刷脸那条路的失败原因来自阿里云（SUB_CODE_MESSAGES，
 * 落定时已经写进 result），护照这条路的原因来自人——它只存在于信封的 reject.reason 里。
 * 不取出来，用户在设置页看到的就是光秃秃三个字「认证未通过」：他不知道是照片糊了、
 * 护照过期了还是姓名对不上，只能原样再交一次，而管理员会再驳回一次。
 *
 * 【为什么内联解密而不是 import passport-realname】那个模块 import 本文件（AUTH_STATUS /
 * VERIFICATION_STATUS 在这里），反向 import 就成环。要的只有三行，不值得为它拆模块。
 *
 * 解不开 / 没有 reject 段一律返回 null，由调用方退回原来的硬编码文案——
 * 一条流水的信封坏掉不该让整个状态接口报错。
 */
function passportRejectReason(row: store.RealnameVerificationRow): string | null {
  if (row.provider !== PASSPORT_PROVIDER || !row.raw_meta_enc) return null;
  try {
    const env = JSON.parse(decryptField(row.raw_meta_enc)) as {
      reject?: { reason?: unknown };
    };
    const reason = env.reject?.reason;
    return typeof reason === 'string' && reason.trim() ? reason : null;
  } catch {
    return null;
  }
}

/**
 * 发起实名认证：调阿里云 → 落一条 待审 流水 → 把 H5 认证 URL 交给前端。
 * 幂等策略是"允许重复发起"：每次都是新流水（改名/换证也走这条路），
 * 轮询只认最新一行，旧的未完成流水自然作废。
 */
export async function startRealname(
  db: Database,
  input: { userId: number; realName: string; idCard: string },
  deps: RealnameDeps = {},
): Promise<StartRealnameResult> {
  const certName = (input.realName ?? '').trim();
  const certNo = (input.idCard ?? '').trim().toUpperCase();
  if (!certName) return fail(400, 'INVALID_REAL_NAME', '姓名不能为空');
  if (!isIdCard(certNo)) return fail(400, 'INVALID_ID_CARD', '身份证号格式不正确');

  const user = users.findUserById(db, input.userId);
  if (!user) return fail(401, 'UNAUTHORIZED', '登录状态已失效，请重新验证手机号');

  const returnUrl = `${(process.env.CLOUDAUTH_RETURN_URL_BASE ?? '').replace(/\/+$/, '')}/realname/callback`;

  let init: InitFaceVerifyResult;
  try {
    init = await (deps.init ?? initFaceVerify)({
      userId: input.userId,
      certName,
      certNo,
      returnUrl,
    });
  } catch (err) {
    return fail(502, 'REALNAME_INIT_FAILED', err instanceof Error ? err.message : '实人认证发起失败');
  }

  const envelope: MetaEnvelope = { cert_name: certName, cert_no: certNo };
  const verificationId = store.insertVerification(db, {
    userId: input.userId,
    provider: PROVIDER,
    certNo: init.certifyId,
    status: VERIFICATION_STATUS.pending,
    rawMetaEnc: encryptField(JSON.stringify(envelope)),
  });
  users.setUserAuthStatus(db, input.userId, AUTH_STATUS.pending);

  return {
    ok: true,
    verificationId,
    certifyId: init.certifyId,
    certifyUrl: init.certifyUrl,
  };
}

/**
 * 查认证结果并落定。
 * 幂等：只有最新一行还是「待审」时才去问阿里云；已经落定（已实名/未通过）直接回存量结论，
 * 前端多刷几次不会重复回填 users、也不会重复消耗阿里云查询额度。
 */
export async function refreshRealnameStatus(
  db: Database,
  input: { userId: number },
  deps: RealnameDeps = {},
): Promise<RealnameStatusResult> {
  const user = users.findUserById(db, input.userId);
  if (!user) return fail(401, 'UNAUTHORIZED', '登录状态已失效，请重新验证手机号');

  const row = store.latestByUser(db, input.userId);
  if (!row) {
    return {
      ok: true,
      authStatus: user.auth_status,
      verificationStatus: null,
      method: null,
      message: '尚未发起实名认证',
    };
  }
  if (row.status !== VERIFICATION_STATUS.pending) {
    return {
      ok: true,
      authStatus: user.auth_status,
      verificationStatus: row.status,
      method: row.provider,
      message:
        row.status === VERIFICATION_STATUS.passed
          ? '认证通过'
          : (passportRejectReason(row) ?? '认证未通过'),
    };
  }

  /**
   * 【护照通道必须在这里岔开】下面两步都是 cloudauth 专属：
   *  · `!row.cert_no → 500 REALNAME_BROKEN`：护照流水的 cert_no **按设计恒为 null**
   *    （护照号是 PII，只进 raw_meta_enc，不进那列）⇒ 不岔开的话，
   *    **每一个待审的护照用户查一次状态就拿一个 500**。
   *  · `describeFaceVerify(row.cert_no)`：拿 null 去问阿里云的人脸结果，本就没有那回事。
   * 护照的「待审」要靠人工审核推进，不靠轮询三方。
   */
  if (row.provider === PASSPORT_PROVIDER) {
    return {
      ok: true,
      authStatus: user.auth_status,
      verificationStatus: row.status,
      method: row.provider,
      message: '材料已提交，等待人工核验',
    };
  }

  if (!row.cert_no) return fail(500, 'REALNAME_BROKEN', '认证流水缺少认证号，请重新发起认证');

  let result: DescribeFaceVerifyResult;
  try {
    result = await (deps.describe ?? describeFaceVerify)(row.cert_no);
  } catch (err) {
    return fail(
      502,
      'REALNAME_QUERY_FAILED',
      err instanceof Error ? err.message : '实人认证结果查询失败',
    );
  }

  // passedRaw 为 null = 用户还没做完，保持待审，不动流水也不动 users
  if (result.passedRaw === null) {
    return {
      ok: true,
      authStatus: user.auth_status,
      verificationStatus: row.status,
      method: row.provider,
      message: '认证进行中，请在手机上完成人脸核验',
    };
  }

  // 姓名证件号只在这个信封里；解不出来就无法回填 users，宁可报错也不落一个"通过但没实名信息"的状态
  const envelope = readEnvelope(row.raw_meta_enc);
  if (!envelope) return fail(500, 'REALNAME_BROKEN', '认证流水已损坏，请重新发起认证');

  const status = result.passed ? VERIFICATION_STATUS.passed : VERIFICATION_STATUS.failed;
  store.setStatus(
    db,
    row.id,
    status,
    encryptField(JSON.stringify({ ...envelope, result: result.raw })),
  );

  if (result.passed) {
    users.setUserRealname(db, input.userId, {
      realNameEnc: encryptField(envelope.cert_name),
      idCardEnc: encryptField(envelope.cert_no),
      authStatus: AUTH_STATUS.verified,
      // 走这条路的必然是大陆身份证（阿里云实人认证只认它）。
      // 显式写下来，掩码才不必靠长度猜——见 attest.ts maskCertNo 的说明。
      certType: CERT_TYPE.idCard,
    });
  } else {
    users.setUserAuthStatus(db, input.userId, AUTH_STATUS.none);
  }

  return {
    ok: true,
    authStatus: result.passed ? AUTH_STATUS.verified : AUTH_STATUS.none,
    verificationStatus: status,
    method: PROVIDER,
    message: result.message,
  };
}
