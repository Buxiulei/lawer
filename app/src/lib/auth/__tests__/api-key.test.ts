// app/src/lib/auth/__tests__/api-key.test.ts
// api key 是 agent 直连的长期凭据，泄漏了就是别人拿到整份案件档案。
// 三条不能松：明文不落库（只存 SHA256）、比对常数时间、scopes 解析失败必须"降权"而不是"提权"。
import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

import {
  ALL_SCOPES,
  DEFAULT_SCOPES,
  generateApiKey,
  hashApiKey,
  normalizeRequestedScopes,
  parseScopes,
  verifyApiKey,
} from '../api-key';

describe('generateApiKey', () => {
  test('32 字节熵的 URL-safe 串，不含 base64 的 +/= 也不含点', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 字节 base64url 无填充 = 43 字符
    expect(key).toHaveLength(43);
    // 不含 '.' 才不会被误认成 JWT 的三段式
    expect(key).not.toContain('.');
  });

  test('每次都不同', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });
});

describe('hashApiKey / verifyApiKey', () => {
  test('存的是 SHA256 hex，从摘要看不出明文', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    // 与标准实现逐字一致（等价于 python hashlib.sha256(key).hexdigest()）
    expect(hash).toBe(crypto.createHash('sha256').update(key, 'utf-8').digest('hex'));
  });

  test('对得上返回 true，改一个字符就 false', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(verifyApiKey(key, hash)).toBe(true);
    expect(verifyApiKey(`${key}x`, hash)).toBe(false);
    expect(verifyApiKey(generateApiKey(), hash)).toBe(false);
  });

  test('长度不等的摘要不会让 timingSafeEqual 抛错', () => {
    // timingSafeEqual 对长度不等的入参会 throw，必须先挡住
    const key = generateApiKey();
    expect(() => verifyApiKey(key, '')).not.toThrow();
    expect(verifyApiKey(key, '')).toBe(false);
    expect(verifyApiKey(key, 'abc')).toBe(false);
    expect(verifyApiKey(key, null as unknown as string)).toBe(false);
  });
});

describe('parseScopes（库里读出来）', () => {
  test('正常 JSON 数组照解', () => {
    expect(parseScopes('["case:read","case:write"]')).toEqual(['case:read', 'case:write']);
    expect(parseScopes('["case:read"]')).toEqual(['case:read']);
  });

  test('NULL / 坏 JSON / 非数组 / 未知 scope 一律降权，绝不当成全权', () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes('not json')).toEqual([]);
    expect(parseScopes('"case:read"')).toEqual([]);
    expect(parseScopes('{"case:read":true}')).toEqual([]);
    // 混进未知项时只保留认识的，不整体放行
    expect(parseScopes('["case:read","admin:everything"]')).toEqual(['case:read']);
  });
});

describe('normalizeRequestedScopes（创建 key 时的入参）', () => {
  test('不传就给默认全集，落库时总是显式数组', () => {
    expect(normalizeRequestedScopes(undefined)).toEqual([...DEFAULT_SCOPES]);
    expect(normalizeRequestedScopes(null)).toEqual([...DEFAULT_SCOPES]);
  });

  test('显式收紧权限', () => {
    expect(normalizeRequestedScopes(['case:read'])).toEqual(['case:read']);
    expect(normalizeRequestedScopes([])).toEqual([]);
  });

  test('含未知 scope 返回 null（拒绝创建），不静默丢弃', () => {
    expect(normalizeRequestedScopes(['case:read', 'admin'])).toBeNull();
    expect(normalizeRequestedScopes('case:read')).toBeNull();
    expect(normalizeRequestedScopes({})).toBeNull();
  });

  test('去重', () => {
    expect(normalizeRequestedScopes(['case:read', 'case:read'])).toEqual(['case:read']);
  });

  test('ALL_SCOPES 就是当前认识的全部权限', () => {
    expect([...ALL_SCOPES]).toEqual(['case:read', 'case:write']);
  });
});
