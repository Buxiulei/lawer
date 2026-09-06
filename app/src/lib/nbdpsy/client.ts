// app/src/lib/nbdpsy/client.ts
// 与 NBDpsy 那侧 `/api/internal/*` 的机器间调用（设计稿 §14 决定 1；契约 T259 v1.3）。
//
// 【只有两条调用，且都不直连对方的库】
//   identityStatus(phone)        —— 问「这个手机号在你们那边实名过没有」（实名互认读侧）
//   createReferralLead(payload)  —— 把一份转介数据包投进对方的 leads
// 不同步咨询记录、不读对方咨询内容、不在 MCP 暴露对方数据（§14「不做」三条）。
//
// 【鉴权：HMAC 签名（契约 v1.3 §0）】三个请求头：
//   X-Source: tubashu
//   X-Timestamp: 秒级时间戳（对方校 ±300s）
//   X-Signature: `sha256=` + hex(HMAC-SHA256(secret, `${ts}\n${raw_body}`))
// 签名串是「时间戳 + 换行 + 请求体逐字原文」——ts 进签名是为了防重放（改了时间戳签名就变）；
// 只签 body 不签 ts 的形态是：抓到一次请求就能无限期重放它。密钥 env NBDPSY_INTERNAL_SECRET、
// 基址 env NBDPSY_INTERNAL_BASE。
//
// 【防重放：body 内带 nonce（契约 v1.3 §0）】每次调用往请求体里塞一个 16 字节随机 hex，
// 随 body 一起被签；对方按 (source, nonce) 唯一，重放回 409。nonce 由本文件生成，调用方不用管。
//
// 【两条都用 POST】签名算在请求体上，GET 没有体、HMAC(secret, 常数) 对所有手机号都有效，
// 等于把「查谁实名过」对外开放。identity/status 也走 POST（契约 v1.3 已确认 POST）。
//
// 【缺 env ⇒ 未接通，不是错误】没配基址或密钥时不抛错、不猜默认地址，一律回
// `{ ok:false, reason:'NOT_CONNECTED' }`。上层据此把转介留在 pending 等重试、把实名互认按
// 「查不到」处理。抛错的形态是：一个还没接线的联调环境，会让用户的转介直接判死。
import { createHmac, randomBytes } from 'node:crypto';

/** 对方那两条内部接口的路径（相对基址，契约 v1.3）。 */
const PATH_IDENTITY_STATUS = '/api/internal/identity/v1/status';
const PATH_REFERRAL_LEAD = '/api/internal/leads/v1/referral';

/** 固定来源标识（契约 v1.3 §0：X-Source 必须等于 tubashu）。 */
const SOURCE = 'tubashu';

/** 同机 localhost 调用，超时给得短：它挂在用户的一次请求上（实名互认那条）。 */
const TIMEOUT_MS = 8_000;

export type FetchImpl = typeof fetch;

/** 调不通的几种形态。分开是因为上层的处置不同（见各自注释与 referral-worker 的记账）。 */
export type NbdpsyFailureReason =
  /** 没配 env：我们自己没接线，不算这次调用的失败（不计入尝试次数） */
  | 'NOT_CONNECTED'
  /** 网络层出不去（连不上、超时） */
  | 'UNREACHABLE'
  /** 对方限流（HTTP 429）：稍后自动重试，**不计入尝试次数**（否则未鉴权/限流会白白烧掉配额） */
  | 'RATE_LIMITED'
  /** 连上了，但对方回了非 2xx 或读不懂的体 */
  | 'BAD_RESPONSE';

export interface NbdpsyFailure {
  ok: false;
  reason: NbdpsyFailureReason;
  /** 自述三段式：缺什么 / 为什么缺 / 怎么办。原样进 referrals.last_error */
  message: string;
}

export interface NbdpsyConfig {
  base: string;
  secret: string;
}

/** 读 env；缺任一项即「未接通」。**不给默认基址**——猜一个地址会把请求发去别处。 */
export function nbdpsyConfig(): NbdpsyConfig | null {
  const base = process.env.NBDPSY_INTERNAL_BASE?.trim();
  const secret = process.env.NBDPSY_INTERNAL_SECRET?.trim();
  if (!base || !secret) return null;
  return { base: base.replace(/\/+$/, ''), secret };
}

/** 接没接通。读侧据它决定「要不要去问对方」，不要各处自己读 env。 */
export function nbdpsyConfigured(): boolean {
  return nbdpsyConfig() !== null;
}

const NOT_CONNECTED: NbdpsyFailure = {
  ok: false,
  reason: 'NOT_CONNECTED',
  message:
    '还没接通 NBDpsy 的内部接口，这次没有发出去（本条转介留在待发送，会自动重试）。' +
    '为什么：本机没有配置 NBDPSY_INTERNAL_BASE / NBDPSY_INTERNAL_SECRET 两个环境变量。' +
    '怎么办：由运维在 app.env 里补上这两项并重启；补上之前用户的资料不会外发。',
};

/**
 * 契约 v1.3 的签名值：`sha256=` + hex(HMAC-SHA256(secret, `${ts}\n${rawBody}`))。
 * **签名串 = 时间戳 + 换行 + 请求体逐字原文**。ts 必须与 X-Timestamp 头逐字相同，
 * rawBody 必须与实际发出去的 body 逐字相同（都不能再序列化一次）。
 */
export function signRequest(secret: string, ts: number | string, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${ts}\n${rawBody}`, 'utf-8').digest('hex');
  return `sha256=${mac}`;
}

/** 请求体里那个防重放随机数：16 字节 → 32 位 hex（契约 v1.3 §0）。 */
function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** 从对方错误体 `{ok:false,error:code}` 里取出 error 码；取不到回 null。 */
function errorCodeOf(text: string): string | null {
  try {
    const p = JSON.parse(text) as { error?: unknown };
    return typeof p.error === 'string' && p.error ? p.error : null;
  } catch {
    return null;
  }
}

/** 非 2xx → 分类 + 自述三段式（契约 v1.3 §0 码表）。 */
function mapHttpError(path: string, status: number, text: string): NbdpsyFailure {
  const code = errorCodeOf(text);
  const tail = code ? `（error=${code}）` : '';
  if (status === 429) {
    return {
      ok: false,
      reason: 'RATE_LIMITED',
      message:
        `NBDpsy 的 ${path} 回了限流 HTTP 429${tail}，本次没送达（会自动重试，不计入尝试次数）。` +
        '为什么：最近 60 秒内向对方发得太密。' +
        '怎么办：无需处理，队列稍后自动再发。',
    };
  }
  let why: string;
  let how = '怎么办：这一条会自动重试；持续失败请把这条错误连同报价号/线索发给我们。';
  if (status === 401) {
    why = '签名没过——多半是 NBDPSY_INTERNAL_SECRET 两边不一致，或签名串没按「时间戳\\n请求体」拼。';
    how = '怎么办：核对 NBDPSY_INTERNAL_SECRET 与对方一致、且客户端签的是 `${ts}\\n${body}`。';
  } else if (status === 403) {
    why = '对方不认这个来源——X-Source 必须是 tubashu，且对方要为本来源配好专属密钥。';
    how = '怎么办：请对方确认已配置本来源的专属密钥（未配置时对方会拒绝）。';
  } else if (status === 400) {
    why = '这次请求对方不收——本侧发的字段、手机号或摘要长度不合 v1.3 约定（缺 nonce 也在此列）。';
    how = '怎么办：这条不重试也修不好，需要按契约 v1.3 修正请求内容后重新发起。';
  } else if (status === 409) {
    why = '对方判为重放（同一 nonce 又来了一次）——正常不该发生，每次调用都会换新 nonce。';
  } else {
    why = '对方内部错误（server_misconfig / server_error）。';
  }
  return {
    ok: false,
    reason: 'BAD_RESPONSE',
    message: `NBDpsy 的 ${path} 回了 HTTP ${status}${tail}。为什么：${why}${how}`,
  };
}

async function postSigned(
  cfg: NbdpsyConfig,
  path: string,
  payload: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; body: Record<string, unknown> } | NbdpsyFailure> {
  // nonce 进体、体只序列化一次：签名与实际发出去的必须逐字一致（两次 stringify 键序不保证相同）。
  const rawBody = JSON.stringify({ ...payload, nonce: newNonce() });
  const ts = Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-source': SOURCE,
        'x-timestamp': String(ts),
        'x-signature': signRequest(cfg.secret, ts, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'UNREACHABLE',
      message:
        `连不上 NBDpsy 的 ${path}：${err instanceof Error ? err.message : String(err)}。` +
        '为什么：对方服务没起、地址不通，或超过了 8 秒。' +
        '怎么办：这一条会自动重试；持续失败请查对方服务与 NBDPSY_INTERNAL_BASE 是否指对。',
    };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) return mapHttpError(path, res.status, text);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象');
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      reason: 'BAD_RESPONSE',
      message:
        `NBDpsy 的 ${path} 回了读不懂的内容（前 200 字）：${text.slice(0, 200)}。` +
        '为什么：对方返回的不是 JSON 对象（可能被网关拦了，返回了一页 HTML）。' +
        '怎么办：确认基址指向的是内部接口而不是站点前端。',
    };
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ───────────────────────────── 实名互认（读） ─────────────────────────────

/** 对方人级实名终态的快照。证件号只拿掩码，明文一律不取、也不接收。 */
export interface NbdpsyIdentity {
  ok: true;
  /** 对方回包 verified===true（契约 v1.3：人级终态 users.auth_status='approved'） */
  approved: boolean;
  realName: string | null;
  idType: string | null;
  /** 已掩码的证件号，如 `110***********1234`。**这是对外唯一形态**（契约 v1.3 已不回全号） */
  idMasked: string | null;
  verifiedAt: string | null;
  customerCode: string | null;
}

/**
 * 按已验证手机号问对方的实名终态（§14 决定 2：匹配键 = 已验证手机号）。
 *
 * 手机号明文出网**只到对方这一跳**（同机 localhost），且只用于匹配；证件号只收
 * `id_number_masked`（契约 v1.3：对方已不回全号）——即便对方哪天回了明文，本函数也只读
 * 掩码那个键，不给它进到本库的路径（identity-link.adoptIdentity 还会再掩一次兜底）。
 */
export async function identityStatus(
  phone: string,
  fetchImpl: FetchImpl = fetch,
): Promise<NbdpsyIdentity | NbdpsyFailure> {
  const cfg = nbdpsyConfig();
  if (!cfg) return NOT_CONNECTED;

  const res = await postSigned(cfg, PATH_IDENTITY_STATUS, { phone }, fetchImpl);
  if (!res.ok) return res;

  const b = res.body;
  return {
    ok: true,
    approved: b.verified === true,
    realName: str(b.real_name),
    idType: str(b.id_type),
    idMasked: str(b.id_number_masked),
    verifiedAt: str(b.verified_at),
    customerCode: str(b.customer_code),
  };
}

// ───────────────────────────── 转介（写） ─────────────────────────────

export interface NbdpsyLeadAccepted {
  ok: true;
  /** 对方 leads 那条线索的 id，落回 referrals.external_ref */
  externalRef: string;
  /** 对方判为重复（幂等命中）：契约 v1.3 回 200 duplicate:true。同样视为已送达 */
  duplicate: boolean;
}

/** 对方回的线索 id：契约 v1.3 是数字，历史/联调也可能给字符串——都归一成字符串。 */
function refId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * 投一份转介数据包到对方的 leads（契约 v1.3 §2）。
 *
 * 【201 首插与 200 duplicate 都算已送达】对方按 (source_case_hash, consent_at) 幂等：
 * 首插回 201 duplicate:false，重复回 200 duplicate:true——两者都带 lead_id，都记成 sent、
 * external_ref 用 lead_id。把 duplicate 当失败重发的形态是：同一条转介被反复投递。
 *
 * 【对方回 2xx 但没给 lead_id 也算失败】没有 external_ref 的 sent 是查不回去的：
 * 用户问「我那条转介到底有没有过去」时我们答不上来。宁可留在 pending 重试。
 */
export async function createReferralLead(
  payload: Record<string, unknown>,
  fetchImpl: FetchImpl = fetch,
): Promise<NbdpsyLeadAccepted | NbdpsyFailure> {
  const cfg = nbdpsyConfig();
  if (!cfg) return NOT_CONNECTED;

  const res = await postSigned(cfg, PATH_REFERRAL_LEAD, payload, fetchImpl);
  if (!res.ok) return res;

  const ref = refId(res.body.lead_id) ?? refId(res.body.id) ?? refId(res.body.external_ref);
  if (!ref) {
    return {
      ok: false,
      reason: 'BAD_RESPONSE',
      message:
        'NBDpsy 收下了这条转介但没回线索 id，本次不记成已送达。' +
        '为什么：回包里没有 lead_id / id / external_ref 任何一个键，没有 id 就查不回这条线索。' +
        '怎么办：这一条会自动重试；请对方在回包里带上线索 id。',
    };
  }
  return { ok: true, externalRef: ref, duplicate: res.body.duplicate === true };
}
