// app/src/lib/auth/__tests__/identity.test.ts
// Bearer 双态：同一个头，JWT 与 api key 都要认得出，且认错人是最严重的失败。
import { beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

import { generateApiKey, hashApiKey } from '../api-key';
import { extractBearer, hasScope, resolveIdentity } from '../identity';
import { signToken } from '../jwt';
import { makeFixture } from '@/lib/cases/__tests__/fixtures';

const NOW = new Date('2026-08-19T10:00:00.000Z');

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

/** 给某用户造一把 key，返回明文 */
function issueKey(
  db: ReturnType<typeof makeFixture>['db'],
  userId: number,
  scopes: string[],
  enabled = 1,
): string {
  const key = generateApiKey();
  db.prepare(
    'INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, 'test', hashApiKey(key), JSON.stringify(scopes), enabled, NOW.toISOString());
  return key;
}

function headers(value: string, name = 'authorization'): Headers {
  return new Headers({ [name]: value });
}

describe('extractBearer', () => {
  test('Authorization: Bearer 与 X-API-Key 都能取到', () => {
    expect(extractBearer(headers('Bearer abc123'))).toBe('abc123');
    expect(extractBearer(headers('bearer   abc123'))).toBe('abc123');
    expect(extractBearer(headers('abc123', 'x-api-key'))).toBe('abc123');
  });

  test('缺头 / 空值 / 别的 scheme 返回 null', () => {
    expect(extractBearer(new Headers())).toBeNull();
    expect(extractBearer(headers('Bearer    '))).toBeNull();
    expect(extractBearer(headers('Basic abc'))).toBeNull();
  });
});

describe('resolveIdentity', () => {
  test('JWT → via=jwt，网页登录态视为全权', () => {
    const { db, userA } = makeFixture();
    const identity = resolveIdentity(db, headers(`Bearer ${signToken(userA, NOW)}`), NOW);
    expect(identity).toMatchObject({ uid: userA, via: 'jwt' });
    expect(hasScope(identity!, 'case:read')).toBe(true);
    expect(hasScope(identity!, 'case:write')).toBe(true);
  });

  test('过期 JWT 不会被当成 api key 去查库，直接 null', () => {
    const { db, userA } = makeFixture();
    const stale = signToken(userA, new Date('2020-01-01T00:00:00Z'));
    expect(resolveIdentity(db, headers(`Bearer ${stale}`), NOW)).toBeNull();
  });

  test('api key → via=api_key，scopes 照库里的来', () => {
    const { db, userA } = makeFixture();
    const key = issueKey(db, userA, ['case:read']);

    const identity = resolveIdentity(db, headers(`Bearer ${key}`), NOW);
    expect(identity).toMatchObject({ uid: userA, via: 'api_key' });
    expect(hasScope(identity!, 'case:read')).toBe(true);
    // 只授了读，写必须拒绝
    expect(hasScope(identity!, 'case:write')).toBe(false);
  });

  test('X-API-Key 头同样认', () => {
    const { db, userA } = makeFixture();
    const key = issueKey(db, userA, ['case:read']);
    expect(resolveIdentity(db, headers(key, 'x-api-key'), NOW)).toMatchObject({
      uid: userA,
      via: 'api_key',
    });
  });

  test('命中即刷新 last_used_at', () => {
    const { db, userA } = makeFixture();
    const key = issueKey(db, userA, ['case:read']);
    expect(db.prepare('SELECT last_used_at FROM api_keys').get()).toEqual({ last_used_at: null });

    resolveIdentity(db, headers(`Bearer ${key}`), NOW);
    expect(db.prepare('SELECT last_used_at FROM api_keys').get()).toEqual({
      last_used_at: NOW.toISOString(),
    });
  });

  test('已吊销的 key 一律 null', () => {
    const { db, userA } = makeFixture();
    const key = issueKey(db, userA, ['case:read'], 0);
    expect(resolveIdentity(db, headers(`Bearer ${key}`), NOW)).toBeNull();
  });

  test('伪造/不存在的 key、空头一律 null', () => {
    const { db } = makeFixture();
    expect(resolveIdentity(db, headers(`Bearer ${generateApiKey()}`), NOW)).toBeNull();
    expect(resolveIdentity(db, headers('Bearer short'), NOW)).toBeNull();
    expect(resolveIdentity(db, new Headers(), NOW)).toBeNull();
  });

  test('key 只解析出它自己主人的 uid，不会串号', () => {
    const { db, userA, userB } = makeFixture();
    const keyA = issueKey(db, userA, ['case:read']);
    const keyB = issueKey(db, userB, ['case:read']);
    expect(resolveIdentity(db, headers(`Bearer ${keyA}`), NOW)!.uid).toBe(userA);
    expect(resolveIdentity(db, headers(`Bearer ${keyB}`), NOW)!.uid).toBe(userB);
  });

  test('scopes 列是坏数据时降权成无权限，而不是放行', () => {
    const { db, userA } = makeFixture();
    const key = generateApiKey();
    db.prepare(
      'INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(userA, 'broken', hashApiKey(key), 'not-json', NOW.toISOString());

    const identity = resolveIdentity(db, headers(`Bearer ${key}`), NOW);
    expect(identity).toMatchObject({ uid: userA, via: 'api_key' });
    expect(hasScope(identity!, 'case:read')).toBe(false);
    expect(hasScope(identity!, 'case:write')).toBe(false);
  });
});
