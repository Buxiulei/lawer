// app/src/lib/auth/__tests__/jwt.test.ts
// token 是「我是谁」的唯一凭据：签名可伪造或过期不生效，等于任何人都能读别人的案件档案。
import { beforeEach, describe, expect, test } from 'vitest';

import { TOKEN_TTL_SECONDS, signToken, verifyAuthHeader, verifyToken } from '../jwt';

const T0 = new Date('2026-08-19T10:00:00.000Z');

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
});

describe('signToken / verifyToken', () => {
  test('签发的 token 能验回同一个 uid，exp = iat + 7 天', () => {
    const token = signToken(42, T0);
    const payload = verifyToken(token, T0)!;
    expect(payload.uid).toBe(42);
    expect(payload.exp - payload.iat).toBe(TOKEN_TTL_SECONDS);
    expect(payload.iat).toBe(Math.floor(T0.getTime() / 1000));
    // payload 最小化：不夹带会变的状态
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'uid']);
  });

  test('第 7 天差 1 秒仍有效，到点即失效', () => {
    const token = signToken(1, T0);
    const almost = new Date(T0.getTime() + (TOKEN_TTL_SECONDS - 1) * 1000);
    const expired = new Date(T0.getTime() + TOKEN_TTL_SECONDS * 1000);
    expect(verifyToken(token, almost)).not.toBeNull();
    expect(verifyToken(token, expired)).toBeNull();
  });

  test('改 payload、改签名、换密钥、格式不对一律返回 null', () => {
    const token = signToken(7, T0);
    const [header, payload, signature] = token.split('.');

    // 把 uid 改成 9999 但沿用原签名
    const forgedPayload = Buffer.from(JSON.stringify({ uid: 9999, iat: 0, exp: 9e9 })).toString('base64url');
    expect(verifyToken(`${header}.${forgedPayload}.${signature}`, T0)).toBeNull();

    expect(verifyToken(`${header}.${payload}.${signature}x`, T0)).toBeNull();
    expect(verifyToken('not-a-token', T0)).toBeNull();
    expect(verifyToken('', T0)).toBeNull();

    process.env.JWT_SECRET = 'another-secret';
    expect(verifyToken(token, T0)).toBeNull();
  });

  test('缺少 JWT_SECRET 时直接抛错，不静默降级', () => {
    delete process.env.JWT_SECRET;
    expect(() => signToken(1, T0)).toThrow(/JWT_SECRET/);
  });
});

describe('verifyAuthHeader', () => {
  test('识别 Bearer 前缀（大小写不敏感），缺头或格式不对返回 null', () => {
    const token = signToken(5, T0);
    expect(verifyAuthHeader(`Bearer ${token}`, T0)!.uid).toBe(5);
    expect(verifyAuthHeader(`bearer  ${token}`, T0)!.uid).toBe(5);
    expect(verifyAuthHeader(token, T0)).toBeNull();
    expect(verifyAuthHeader(null, T0)).toBeNull();
  });
});
