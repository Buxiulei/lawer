// app/src/lib/auth/api-key.ts
// api key 的生成 / 摘要 / 校验，语义照搬 nbdpsy-server app/core/security.py：
//   generate → secrets.token_urlsafe(32) 等价物（32 字节熵的 URL-safe 串）
//   hash     → SHA256 hex，**库里只存这个**
//   verify   → 常数时间比较，防时序侧信道
// 与 JWT 的分工：JWT 是网页用户的登录态（7 天，会过期）；api key 是用户自己的 agent
// 直连用的长期凭据（不过期，只能吊销）。两者都走 Authorization: Bearer，见 identity.ts。
import crypto from 'node:crypto';

/** 可授予的能力。创建 key 时不指定就落全集（见 DEFAULT_SCOPES），不留 NULL 语义歧义。 */
export const ALL_SCOPES = ['case:read', 'case:write'] as const;
export type Scope = (typeof ALL_SCOPES)[number];

/** 不传 scopes 时授予的默认集合 = 全集。用户要收紧就显式传。 */
export const DEFAULT_SCOPES: readonly Scope[] = ALL_SCOPES;

/** 生成新 key 明文。32 字节熵 base64url，无填充、不含 '.'（与 JWT 天然可区分）。 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA256 hex。库里存的就是它，明文不落库。 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf-8').digest('hex');
}

/**
 * 常数时间比较 key 与库里的摘要。
 * 反查本身是按 hash 走 UNIQUE 索引的等值查询，这里再比一次是为了不把
 * "比对"这一步的耗时差异暴露出去（照抄 NBDpsy verify_apikey 的做法）。
 */
export function verifyApiKey(key: string, storedHash: string): boolean {
  const computed = Buffer.from(hashApiKey(key));
  const stored = Buffer.from(storedHash ?? '');
  return computed.length === stored.length && crypto.timingSafeEqual(computed, stored);
}

/** 把 scopes 列（JSON 数组字符串）解析成集合；格式不对一律当作"无任何权限"。 */
export function parseScopes(scopesJson: string | null): Scope[] {
  if (!scopesJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is Scope => (ALL_SCOPES as readonly unknown[]).includes(s));
}

/** 校验用户传来的 scopes 入参；返回 null 表示含未知 scope，应拒绝创建。 */
export function normalizeRequestedScopes(input: unknown): Scope[] | null {
  if (input === undefined || input === null) return [...DEFAULT_SCOPES];
  if (!Array.isArray(input)) return null;
  const out: Scope[] = [];
  for (const item of input) {
    if (!(ALL_SCOPES as readonly unknown[]).includes(item)) return null;
    if (!out.includes(item as Scope)) out.push(item as Scope);
  }
  return out;
}
