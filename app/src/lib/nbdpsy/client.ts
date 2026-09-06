// app/src/lib/nbdpsy/client.ts
// 与 NBDpsy 那侧 `/api/internal/*` 的机器间调用（设计稿 §14 决定 1）。
//
// 【只有两条调用，且都不直连对方的库】
//   identityStatus(phone)        —— 问「这个手机号在你们那边实名过没有」（实名互认读侧）
//   createReferralLead(payload)  —— 把一份转介数据包投进对方的 leads
// 不同步咨询记录、不读对方咨询内容、不在 MCP 暴露对方数据（§14「不做」三条）。
//
// 【鉴权：HMAC 签名】X-Signature: `sha256=` + hex(HMAC-SHA256(secret, 请求体原文))。
// 密钥 env NBDPSY_INTERNAL_SECRET，基址 env NBDPSY_INTERNAL_BASE。
//
// 【为什么两条都用 POST，而设计稿把 identity/status 写成 GET】签名算在**请求体**上。
// GET 没有体，HMAC(secret, '') 是一个常数——任何人抓到一次请求，就拿到了一把
// 对**所有**手机号都有效的签名，等于把「查谁实名过」这件事对外开放。所以这里两条都发
// POST + JSON 体。**这条与设计稿的字面约定不同，跨仓接口以对方实现为准**：
// 对方若坚持 GET，改这一个文件即可（调用方只认下面两个函数）。
//
// 【缺 env ⇒ 未接通，不是错误】没配基址或密钥时不抛错、不猜一个默认地址，
// 一律回 `{ ok:false, reason:'NOT_CONNECTED' }`。上层据此把转介留在 pending 等重试，
// 把实名互认按「查不到」处理。抛错的形态是：一个还没接线的联调环境，
// 会让用户的转介直接判死。
import { createHmac } from 'node:crypto';

/** 对方那两条内部接口的路径（相对基址）。 */
const PATH_IDENTITY_STATUS = '/api/internal/identity/status';
const PATH_REFERRAL_LEAD = '/api/internal/leads/referral';

/** 同机 localhost 调用，超时给得短：它挂在用户的一次请求上（实名互认那条）。 */
const TIMEOUT_MS = 8_000;

export type FetchImpl = typeof fetch;

/** 调不通的三种形态。分开是因为上层的处置不同（见各自注释）。 */
export type NbdpsyFailureReason =
  /** 没配 env：我们自己没接线，不算这次调用的失败 */
  | 'NOT_CONNECTED'
  /** 网络层出不去（连不上、超时） */
  | 'UNREACHABLE'
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

/** 请求体的签名值。**签的是逐字的体**，所以调用方必须把同一个字符串发出去，不能再序列化一次。 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf-8').digest('hex')}`;
}

async function postSigned(
  cfg: NbdpsyConfig,
  path: string,
  payload: unknown,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; body: Record<string, unknown> } | NbdpsyFailure> {
  // 体只序列化一次：签名与实际发出去的必须逐字一致，两次 stringify 在键序上不保证相同。
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signBody(cfg.secret, body),
      },
      body,
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
  if (!res.ok) {
    return {
      ok: false,
      reason: 'BAD_RESPONSE',
      message:
        `NBDpsy 的 ${path} 回了 HTTP ${res.status}：${text.slice(0, 200)}。` +
        '为什么：多半是签名校验没过（密钥两边不一致），或入参不合对方约定。' +
        '怎么办：核对 NBDPSY_INTERNAL_SECRET 与对方一致后重试。',
    };
  }
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

// ───────────────────────────── 实名互认（读） ─────────────────────────────

/** 对方人级实名终态的快照。证件号只拿掩码，明文一律不取、也不接收。 */
export interface NbdpsyIdentity {
  ok: true;
  /** 对方 users.auth_status === 'approved' */
  approved: boolean;
  realName: string | null;
  idType: string | null;
  /** 已掩码的证件号，如 `110***********1234`。**这是对外唯一形态** */
  idMasked: string | null;
  verifiedAt: string | null;
  customerCode: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 按已验证手机号问对方的实名终态（§14 决定 2：匹配键 = 已验证手机号）。
 *
 * 手机号明文出网**只到对方这一跳**（同机 localhost），且只用于匹配；
 * 回来的证件号只收 `id_masked`——即使对方哪天回了明文，本函数也只读掩码那个键，
 * 不给它进到本库的路径。
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
    approved: b.verified === true || b.approved === true,
    realName: str(b.real_name),
    idType: str(b.id_type),
    idMasked: str(b.id_masked),
    verifiedAt: str(b.verified_at),
    customerCode: str(b.customer_code),
  };
}

// ───────────────────────────── 转介（写） ─────────────────────────────

export interface NbdpsyLeadAccepted {
  ok: true;
  /** 对方 leads 那条线索的 id，落回 referrals.external_ref */
  externalRef: string;
}

/**
 * 投一份转介数据包到对方的 leads。
 *
 * 【对方回 200 但没给 id 也算失败】没有 external_ref 的 sent 是查不回去的：
 * 用户问「我那条转介到底有没有过去」时，我们答不上来。宁可留在 pending 重试。
 */
export async function createReferralLead(
  payload: Record<string, unknown>,
  fetchImpl: FetchImpl = fetch,
): Promise<NbdpsyLeadAccepted | NbdpsyFailure> {
  const cfg = nbdpsyConfig();
  if (!cfg) return NOT_CONNECTED;

  const res = await postSigned(cfg, PATH_REFERRAL_LEAD, payload, fetchImpl);
  if (!res.ok) return res;

  const ref = str(res.body.lead_id) ?? str(res.body.id) ?? str(res.body.external_ref);
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
  return { ok: true, externalRef: ref };
}
