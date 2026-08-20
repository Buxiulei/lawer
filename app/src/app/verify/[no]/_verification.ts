/**
 * 公开验证页的状态判定。纯函数，不碰网络，单测覆盖三态。
 *
 * ── 红线（DESIGN.md「API 对接约定」，来源 WS2 sidecar 契约）──
 * 后端**验签不通过也返回 HTTP 200**，裁决只能看响应体，禁止拿 res.ok / 状态码当结果。
 * 请求异常、JSON 解析失败、字段缺失一律落到「无法验证」中性态——
 * 绝不能因为"没报错"就显示成通过。
 *
 * ── 本批的额外约束（更严）──
 * `GET /api/v1/verify/:orderNo` 目前**不返回 overall_ok**：它只从库里读存证订单，
 * 并没有重新验签（服务端复核接口还不存在）。所以本页**一律不得宣称**
 * 「验证通过 / 签名有效 / 证书链可信」——那会把"记录存在"说成"密码学复核通过"，
 * 是仲裁场上会直接害到用户的谎。stamped/certified 只展示**存证记录**本身，
 * 措辞用「记录一致性由时间戳令牌保证」，并给出离线复核指引让人自己算。
 *
 * 待后端提供带 overall_ok 的复核接口后，才恢复「通过 / 未通过」三态判定 UI：
 * 判定入口写在 readRecheckVerdict()，展示挂点是 VerifyResult 的 recheck 属性。
 */

/** 页面三态：无法验证 / 存证处理中 / 存证记录 */
export type VerifyState = 'unavailable' | 'pending' | 'record';

export interface VerificationEvidence {
  name: string;
  category: string;
  mime: string | null;
  file_size: number;
}

export interface VerificationTimestamp {
  gen_time: string | null;
  serial: string | null;
  tsa_url: string | null;
  tst_b64: string | null;
}

/** GET /api/v1/verify/:orderNo 成功时的 verification 字段（lib/evidence.PublicVerification） */
export interface Verification {
  order_no: string;
  /** pending（订单已建、时间戳还没盖）| stamped（已盖时间戳）| certified（已出《存证证明》） */
  status: string;
  sha256: string;
  created_at: string;
  evidence: VerificationEvidence | null;
  timestamp: VerificationTimestamp;
}

export interface VerifyView {
  state: VerifyState;
  /** state 为 unavailable 时可能为 null */
  verification: Verification | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 把接口响应体读成页面状态。任何读不出订单的情况都是 unavailable，
 * 包括 ok:false、body 不是对象、order_no/sha256 缺失。
 */
export function readVerification(body: unknown): VerifyView {
  if (!isObject(body) || body.ok !== true) return { state: 'unavailable', verification: null };

  const raw = body.verification;
  if (!isObject(raw)) return { state: 'unavailable', verification: null };

  const orderNo = str(raw.order_no);
  const sha256 = str(raw.sha256);
  // 订单号和摘要是这页的立身之本，缺任何一个都不算取到了记录
  if (!orderNo || !sha256) return { state: 'unavailable', verification: null };

  const rawTs = isObject(raw.timestamp) ? raw.timestamp : {};
  const timestamp: VerificationTimestamp = {
    gen_time: nullableStr(rawTs.gen_time),
    serial: nullableStr(rawTs.serial),
    tsa_url: nullableStr(rawTs.tsa_url),
    tst_b64: nullableStr(rawTs.tst_b64),
  };

  const rawEv = isObject(raw.evidence) ? raw.evidence : null;
  const evidence: VerificationEvidence | null = rawEv
    ? {
        name: str(rawEv.name) ?? '未命名文件',
        category: str(rawEv.category) ?? '其他',
        mime: nullableStr(rawEv.mime),
        file_size: typeof rawEv.file_size === 'number' ? rawEv.file_size : 0,
      }
    : null;

  const verification: Verification = {
    order_no: orderNo,
    status: str(raw.status) ?? 'pending',
    sha256,
    created_at: str(raw.created_at) ?? '',
    evidence,
    timestamp,
  };

  // 没有时间戳时间就没有「某时刻已存在」这个结论，无论 status 写的是什么
  const stamped =
    (verification.status === 'stamped' || verification.status === 'certified') &&
    Boolean(timestamp.gen_time);

  return { state: stamped ? 'record' : 'pending', verification };
}

/** 出证状态徽标文案；未知状态按最保守的「存证处理中」处理 */
export function statusLabel(status: string): string {
  if (status === 'certified') return '已出证';
  if (status === 'stamped') return '已固化';
  return '存证处理中';
}

/**
 * 【挂点，暂未启用】服务端复核结果的裁决入口。
 *
 * 后端补上带 overall_ok 的复核接口后，在 page.tsx 里请求它，把响应体交给本函数，
 * 再把结果通过 VerifyResult 的 recheck 属性传下去——那时（也只有那时）
 * 页面才可以出现「验证通过 / 验证未通过」。裁决只看 overall_ok 布尔值，
 * 其余一切情况（缺字段、解析失败、非布尔）都是 unknown，不得当成通过。
 */
export function readRecheckVerdict(body: unknown): 'pass' | 'fail' | 'unknown' {
  if (!isObject(body)) return 'unknown';
  if (body.overall_ok === true) return 'pass';
  if (body.overall_ok === false) return 'fail';
  return 'unknown';
}
