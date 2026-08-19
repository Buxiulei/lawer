// app/src/lib/auth/jwt.ts
// HS256 JWT，node:crypto 手写签发/校验，不引 jsonwebtoken（spec §3.2 依赖能省则省）。
// payload 最小化只放 { uid, iat, exp }：邮箱是否已验证、实名状态这些会变的东西一律现查库，
// 不塞进 token——否则用户改了状态还得等 7 天 token 过期才生效。
import crypto from 'node:crypto';

const ALGO_HEADER = { alg: 'HS256', typ: 'JWT' };
/** 7 天，与 NBDpsy generate_token 一致 */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TokenPayload {
  uid: number;
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('缺少 env JWT_SECRET：JWT 签名密钥未配置，参见 app/.env.example');
  }
  return secret;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string): string {
  return crypto.createHmac('sha256', getSecret()).update(signingInput).digest('base64url');
}

/** 签发 token，有效期 7 天 */
export function signToken(uid: number, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: TokenPayload = { uid, iat, exp: iat + TOKEN_TTL_SECONDS };
  const signingInput = `${b64url(JSON.stringify(ALGO_HEADER))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/**
 * 校验 token。签名不符、格式不对、已过期一律返回 null，不抛错也不区分原因
 * ——对外只有「这个 token 不能用」一种结果，免得反馈给攻击者额外信息。
 */
export function verifyToken(token: string, now: Date = new Date()): TokenPayload | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return null;
  const signingInput = `${parts[0]}.${parts[1]}`;

  const expected = Buffer.from(sign(signingInput));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload?.uid !== 'number' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
  return payload;
}

/** 从 Authorization 头取 Bearer token 并校验，拿不到返回 null */
export function verifyAuthHeader(header: string | null, now: Date = new Date()): TokenPayload | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? verifyToken(match[1].trim(), now) : null;
}
