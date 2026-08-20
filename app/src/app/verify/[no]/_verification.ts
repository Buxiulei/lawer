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
 * 「通过 / 未通过」只能来自另一条接口：POST /api/v1/verify/:orderNo/recheck
 * （WS2 在做，公开 + IP 限流，返回 overall_ok 与分项 checks）。页面上那个
 * 「在线核验」按钮点了才去调它；接口还没上线时按 404 处理，提示改走离线复核。
 * 裁决入口是 readRecheckVerdict()，解析在 readRecheck()。
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

/* ── 在线核验：POST /api/v1/verify/:orderNo/recheck ───────── */

export type RecheckVerdict = 'pass' | 'fail' | 'unknown';

export interface RecheckCheck {
  key: string;
  label: string;
  /** null = 这一项没跑出结论，既不算过也不算不过 */
  ok: boolean | null;
  detail: string | null;
}

export interface Recheck {
  verdict: RecheckVerdict;
  checks: RecheckCheck[];
}

/**
 * 复核结果的裁决入口。**只看 overall_ok 的布尔值**——这是 DESIGN.md 那条红线的落点：
 * 后端验签不通过也回 200，缺字段、解析失败、`"true"` 字符串、1 这类都必须是 unknown。
 * 把 unknown 当通过，等于让无效证据静默过关。
 */
export function readRecheckVerdict(body: unknown): RecheckVerdict {
  if (!isObject(body)) return 'unknown';
  if (body.overall_ok === true) return 'pass';
  if (body.overall_ok === false) return 'fail';
  return 'unknown';
}

/** 已知分项的中文名；接口将来加项也不会漏显示——认不出的 key 原样列出（见 toCheck） */
const CHECK_LABELS: Record<string, string> = {
  hash_match: '文件哈希一致',
  hash: '文件哈希一致',
  tst_valid: '时间戳令牌有效',
  tst: '时间戳令牌有效',
  timestamp: '时间戳令牌有效',
  signature_valid: '签名有效',
  signature: '签名有效',
  sig: '签名有效',
  cert_chain: '证书链可信',
  chain: '证书链可信',
};

/** 分项里表示「过了没有」的字段名，按顺序取第一个布尔值 */
const OK_KEYS = ['ok', 'passed', 'pass', 'valid', 'result', 'success'];
/** 分项里表示说明文字的字段名 */
const DETAIL_KEYS = ['detail', 'message', 'reason', 'note', 'description'];

function pickBool(source: Record<string, unknown>): boolean | null {
  for (const key of OK_KEYS) {
    if (typeof source[key] === 'boolean') return source[key] as boolean;
  }
  return null;
}

function pickStr(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function toCheck(key: string, value: unknown): RecheckCheck {
  // 值本身就是布尔：形如 { checks: { hash_match: true } }
  if (typeof value === 'boolean') {
    return { key, label: CHECK_LABELS[key] ?? key, ok: value, detail: null };
  }
  if (!isObject(value)) {
    return { key, label: CHECK_LABELS[key] ?? key, ok: null, detail: null };
  }
  const rawKey = pickStr(value, ['key', 'name', 'id']) ?? key;
  return {
    key: rawKey,
    // 认不出的项原样列出：宁可显示一个英文 key，也好过悄悄吞掉一条结论
    label: pickStr(value, ['label', 'title']) ?? CHECK_LABELS[rawKey] ?? rawKey,
    ok: pickBool(value),
    detail: pickStr(value, DETAIL_KEYS),
  };
}

/**
 * 宽松解析复核响应：接口字段名还没最终定下来，所以分项的形状按几种常见写法都认，
 * 数组和对象映射都吃得下。认不出的项原样列出，绝不因为不认识就丢掉。
 * 注意 checks 怎么解析都不影响裁决——verdict 只由 overall_ok 决定。
 */
export function readRecheck(body: unknown): Recheck {
  const verdict = readRecheckVerdict(body);
  const raw = isObject(body) ? body.checks : undefined;

  let checks: RecheckCheck[] = [];
  if (Array.isArray(raw)) {
    checks = raw.map((item, i) => toCheck(`check_${i}`, item));
  } else if (isObject(raw)) {
    checks = Object.entries(raw).map(([key, value]) => toCheck(key, value));
  }

  return { verdict, checks };
}
