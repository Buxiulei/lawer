// app/src/lib/auth/passport-realname.ts
// 护照实名通道。
//
// 【为什么要有这条通道】阿里云实人认证只认中国大陆身份证：**只有护照的人根本没有那扇门**。
// 不是"体验不好"，是整条固化链路（attest 需已实名）对他恒不可用。
//
// 【与 cloudauth 通道的关系】同一张 realname_verifications 流水表、同一套 AUTH_STATUS 三态、
// 同一个 requireRealname 闸。差别只在 provider 与"谁来判过没过"：
// cloudauth 问阿里云，本通道由人工核材料后经脚本落定（见 approvePassportRealname）。
// ⇒ status 端点两条路返回同一形状，前端与 lawer 的判据不分叉。
import { type Database } from 'better-sqlite3';

import { openCliDb } from '../db/cli-open';

import { encryptField, decryptField } from '@/lib/crypto';
import * as users from '@/lib/db/otp';
import * as store from '@/lib/db/realname';
import { storeBytes } from '@/lib/evidence/files';
import { CERT_TYPE } from '@/lib/evidence/attest';
import { AUTH_STATUS, VERIFICATION_STATUS } from './realname';

export const PASSPORT_PROVIDER = 'passport';

/** 护照号：各国格式不一，只做"看起来像"的下限校验，不做国别规则 */
const PASSPORT_NO = /^[A-Za-z0-9]{5,20}$/;
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;

export interface PassportMaterial {
  bytes: Buffer;
  mime: string | null;
}

export type PassportInitResult =
  | { ok: true; verificationId: number }
  | { ok: false; status: number; errorCode: string; message: string };

const fail = (status: number, errorCode: string, message: string): PassportInitResult => ({
  ok: false,
  status,
  errorCode,
  message,
});

/**
 * 发起护照实名：收姓名 + 护照号 + 两件材料，落一条「待审」流水。
 *
 * 【护照号只以密文存在】`realname_verifications.cert_no` 那一列，cloudauth 通道存的是
 * 阿里云的 certifyId（provider 侧引用，不是证件号）。本通道**不往那列写护照号**——
 * 那会让一个 PII 明文躺在一张没有加密约定的列里。护照号进 `raw_meta_enc`。
 *
 * 【材料走 files 表】内容寻址 + 加密落盘（storeBytes），与证据同一套纪律。
 * 不塞进 evidence 表：那是案件证据，语义不同，混进去会污染案件材料清单。
 */
export function initPassportRealname(
  db: Database,
  input: {
    userId: number;
    realName: unknown;
    passportNo: unknown;
    idPage: PassportMaterial;
    selfie: PassportMaterial;
  },
): PassportInitResult {
  const user = users.findUserById(db, input.userId);
  if (!user) return fail(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.auth_status === AUTH_STATUS.verified) {
    return fail(409, 'ALREADY_VERIFIED', '已经完成实名认证，不需要再走一次');
  }

  const realName = typeof input.realName === 'string' ? input.realName.trim() : '';
  if (!realName) return fail(400, 'INVALID_NAME', '请填写与护照一致的姓名');

  const passportNo = typeof input.passportNo === 'string' ? input.passportNo.trim() : '';
  if (!PASSPORT_NO.test(passportNo)) {
    return fail(400, 'INVALID_PASSPORT_NO', '护照号格式不正确（5–20 位字母或数字）');
  }

  for (const [name, m] of [
    ['护照资料页', input.idPage],
    ['手持护照自拍', input.selfie],
  ] as const) {
    if (!m?.bytes?.length) return fail(400, 'MISSING_MATERIAL', `缺少${name}`);
    if (m.bytes.length > MAX_MATERIAL_BYTES) {
      return fail(400, 'MATERIAL_TOO_LARGE', `${name}超过 8MB`);
    }
  }

  // 【为什么整体包事务】材料落了盘、流水没落，就是一份没人认领的加密文件躺在磁盘上；
  // 流水落了、材料没落，审核的人打开是空的。两者必须同生同死。
  const run = db.transaction(() => {
    const idPage = storeBytes(db, input.idPage.bytes, input.idPage.mime);
    const selfie = storeBytes(db, input.selfie.bytes, input.selfie.mime);
    const envelope = {
      cert_name: realName,
      cert_no: passportNo,
      cert_type: CERT_TYPE.passport,
      materials: {
        id_page: { file_id: idPage.fileId, sha256: idPage.sha256, size: idPage.size },
        selfie: { file_id: selfie.fileId, sha256: selfie.sha256, size: selfie.size },
      },
    };
    const verificationId = store.insertVerification(db, {
      userId: input.userId,
      provider: PASSPORT_PROVIDER,
      certNo: null, // 见上：护照号不进这列
      status: VERIFICATION_STATUS.pending,
      rawMetaEnc: encryptField(JSON.stringify(envelope)),
    });
    users.setUserAuthStatus(db, input.userId, AUTH_STATUS.pending);
    return verificationId;
  });

  return { ok: true, verificationId: run() };
}

export interface ApprovalPlan {
  verificationId: number;
  userId: number;
  certName: string;
  certNo: string;
  materials: { id_page: { sha256: string }; selfie: { sha256: string } };
}

/**
 * 读一条待审护照流水，算出"将要写什么"——**不写库**。
 * 干跑模式与真执行共用它，所以打印出来的就是接下来会落的那份，不是另算一遍。
 */
export function planPassportApproval(db: Database, verificationId: number): ApprovalPlan {
  const row = store.findById(db, verificationId);
  if (!row) throw new Error(`流水 ${verificationId} 不存在`);
  if (row.provider !== PASSPORT_PROVIDER) {
    throw new Error(`流水 ${verificationId} 不是护照通道（provider=${row.provider}）`);
  }
  if (row.status !== VERIFICATION_STATUS.pending) {
    throw new Error(`流水 ${verificationId} 已落定为「${row.status}」，不可重复审核`);
  }
  if (!row.raw_meta_enc) throw new Error(`流水 ${verificationId} 没有材料元数据`);
  const env = JSON.parse(decryptField(row.raw_meta_enc)) as ApprovalPlan & {
    cert_name: string;
    cert_no: string;
  };
  return {
    verificationId,
    userId: row.user_id,
    certName: env.cert_name,
    certNo: env.cert_no,
    materials: env.materials,
  };
}

/**
 * 人工核过材料之后落定：users 转「已实名」+ 回填姓名/护照号/证件类型，流水转「已实名」。
 *
 * 【留痕写进流水而不是日志】谁核的、何时、核的是哪两份材料（哈希），
 * 跟着这条流水一起存——日志会轮转，流水不会。管理后台以后接的就是这份语义。
 *
 * 【操作面有两个，这里只有一个落定口】原先本函数只由 CLI 调用（`--apply`），
 * 抬头写着"不做 HTTP 端点：实名是身份断言，写它是生产手术"。
 * **2026-09-03 经理裁决 A 推翻了那条**：主理人在 /woo/users 看得到「待审」，
 * 却没有任何审核动作——护照用户因此卡在待审里，而唯一的出路是有人 ssh 上生产跑脚本。
 * 「只能上生产手术」不是审慎，它把一条常规业务动作变成了没人敢做的动作。
 * 现在加了后台端点（app/api/v1/admin/realname/*），闸门是 lib/admin/auth 的 requireAdmin：
 * ADMIN_UIDS 白名单 + 网页登录态，非白名单一律空体 404，api key 同样进不来。
 * CLI 保留不删：它不依赖网页登录态，是白名单配错或前端挂掉时的后路。
 * 两个操作面共用**这一个**落定函数，所以"落定时写什么"永远只有一份实现。
 */
export function approvePassportRealname(
  db: Database,
  input: { verificationId: number; operator: string; note?: string; now?: Date },
): ApprovalPlan {
  const operator = input.operator.trim();
  if (!operator) throw new Error('必须记名审核人：留痕没有"谁"就不成其为留痕');

  const plan = planPassportApproval(db, input.verificationId);
  const at = (input.now ?? new Date()).toISOString();

  const run = db.transaction(() => {
    users.setUserRealname(db, plan.userId, {
      realNameEnc: encryptField(plan.certName),
      idCardEnc: encryptField(plan.certNo),
      authStatus: AUTH_STATUS.verified,
      certType: CERT_TYPE.passport,
    });
    const row = store.findById(db, input.verificationId)!;
    const env = JSON.parse(decryptField(row.raw_meta_enc!)) as Record<string, unknown>;
    env.audit = {
      operator,
      approved_at: at,
      note: input.note ?? null,
      material_sha256: [plan.materials.id_page.sha256, plan.materials.selfie.sha256],
    };
    store.setStatus(
      db,
      input.verificationId,
      VERIFICATION_STATUS.passed,
      encryptField(JSON.stringify(env)),
    );
  });
  run();
  return plan;
}


/** 信封里一份材料的记录（storeBytes 落的那三样）。 */
export interface PassportMaterialRef {
  file_id: number;
  sha256: string;
  size: number;
}

/** 一条护照流水的可读全貌。**含 PII（姓名、护照号）**，只许在 admin 闸门之后出现。 */
export interface PassportRecord {
  verificationId: number;
  userId: number;
  status: string;
  certName: string;
  certNo: string;
  materials: { id_page: PassportMaterialRef; selfie: PassportMaterialRef };
  submittedAt: string;
  /** 通过时写的留痕（没通过/未审为 undefined） */
  audit?: { operator: string; approved_at: string; note: string | null };
  /** 驳回时写的留痕；用户端的「上一次没通过：<原因>」读的就是这里的 reason */
  reject?: { operator: string; rejected_at: string; reason: string };
}

/**
 * 读一条护照流水的全貌，**不带"必须还待审"这道门**——审核台要能翻看已落定的记录。
 *
 * 与 planPassportApproval 的分工：那个是**写前的算式**（状态不对就不许算），
 * 这个是**只读的取件**。别把只读路由接到 planPassportApproval 上：
 * 那样查看一条已通过的记录会抛「已落定，不可重复审核」，一条正常的查看变成一个错误。
 *
 * @returns 查无此行 / 不是护照通道 → null（调用方回 404）；
 *          信封缺失或解不开 → **抛错**（那是密钥或数据坏了，不该伪装成"没这条记录"）
 */
export function readPassportEnvelope(db: Database, verificationId: number): PassportRecord | null {
  const row = store.findById(db, verificationId);
  if (!row || row.provider !== PASSPORT_PROVIDER) return null;
  if (!row.raw_meta_enc) {
    throw new Error(
      `流水 ${verificationId} 没有材料元数据：这条护照流水落库时信封为空，` +
        `无法取出姓名/护照号/材料哈希。请查该行 raw_meta_enc 是否被清过。`,
    );
  }
  const env = JSON.parse(decryptField(row.raw_meta_enc)) as Omit<
    PassportRecord,
    'verificationId' | 'userId' | 'status' | 'certName' | 'certNo' | 'submittedAt'
  > & { cert_name: string; cert_no: string };
  return {
    verificationId: row.id,
    userId: row.user_id,
    status: row.status,
    certName: env.cert_name,
    certNo: env.cert_no,
    materials: env.materials,
    submittedAt: row.created_at,
    audit: env.audit,
    reject: env.reject,
  };
}

/**
 * 人工核过材料后驳回：流水转「未通过」+ 信封里写下谁驳的、何时、为什么；
 * users 打回「未认证」。
 *
 * 【为什么打回"未认证"而不是留在"待审"】留在待审的用户在设置页看到的是
 * 「材料已收到，正在人工审核」——他会一直等一个永远不会来的结果，也交不了新材料
 *（重交路径在前端是"未通过"分支才出现）。cloudauth 失败路径同样是 setUserAuthStatus(none)，
 * 两条通道在这一点上不分叉。
 *
 * 【为什么原因必填、且写进流水】"没通过"而不说为什么，等于让用户猜着重交，
 * 大概率原样再交一次。原因跟着流水存（不是日志）：用户端 /realname/status 要把它原样回显。
 *
 * 复用 planPassportApproval 做前置校验（存在 / 是护照通道 / 还待审）——
 * 落定过的流水不许被二次改写，approve 与 reject 在这一点上必须同一把尺子。
 */
export function rejectPassportRealname(
  db: Database,
  input: { verificationId: number; operator: string; reason: string; now?: Date },
): ApprovalPlan {
  const operator = input.operator.trim();
  if (!operator) throw new Error('必须记名审核人：留痕没有"谁"就不成其为留痕');
  const reason = input.reason.trim();
  if (!reason) throw new Error('驳回必须写明原因：不说为什么，用户只能原样再交一次');

  const plan = planPassportApproval(db, input.verificationId);
  const at = (input.now ?? new Date()).toISOString();

  const run = db.transaction(() => {
    const row = store.findById(db, input.verificationId)!;
    const env = JSON.parse(decryptField(row.raw_meta_enc!)) as Record<string, unknown>;
    env.reject = { operator, rejected_at: at, reason };
    store.setStatus(
      db,
      input.verificationId,
      VERIFICATION_STATUS.failed,
      encryptField(JSON.stringify(env)),
    );
    // 打回未认证，允许重交。users 的其余实名列（real_name_enc / id_card_enc）本就没写过
    // ——提交时只落流水，回填 users 是 approve 那一步的事。
    users.setUserAuthStatus(db, plan.userId, AUTH_STATUS.none);
  });
  run();
  return plan;
}


/**
 * CLI 本体。脚本只负责解析参数与退出码，开库/迁移/事务都在这里——
 * 与 reconcile / backfill 同一分工（scripts/ 解析不到 app/node_modules 的 better-sqlite3，
 * 这个边界本来就是为此存在的）。
 *
 * @returns 退出码：0 正常；1 业务失败（流水不存在/已落定/不是护照通道）；2 用法错
 */
export function approvePassportCli(
  dbPath: string,
  opts: { verificationId: number; operator?: string; note?: string; apply: boolean },
): number {
  const db = openCliDb(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plan = planPassportApproval(db, opts.verificationId);
    console.log(`库：${dbPath}`);
    console.log(`流水 #${plan.verificationId}  用户 ${plan.userId}`);
    console.log(`  姓名     ${plan.certName}`);
    console.log(`  护照号   ${plan.certNo}`);
    console.log(`  资料页   sha256 ${plan.materials.id_page.sha256}`);
    console.log(`  自拍     sha256 ${plan.materials.selfie.sha256}`);
    console.log('');
    console.log('  ⚠ 核对要点：两张图上的姓名与护照号必须与上面逐字一致；');
    console.log('     自拍里的人脸与资料页照片是同一个人；护照在有效期内。');

    if (!opts.apply) {
      console.log('');
      console.log('【干跑】没有写库。确认无误后加 --operator <你的名字> --apply。');
      return 0;
    }
    if (!opts.operator?.trim()) {
      console.error('❌ --apply 必须带 --operator：留痕没有"谁"就不成其为留痕。');
      return 2;
    }
    approvePassportRealname(db, {
      verificationId: opts.verificationId,
      operator: opts.operator,
      note: opts.note,
    });
    console.log('');
    console.log(`✅ 已落定：用户 ${plan.userId} 转「已实名」，流水 #${opts.verificationId} 转「已实名」。`);
    console.log('   留痕：审核人、时刻、两份材料哈希，已写进该条流水的信封。');
    return 0;
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
