// app/src/lib/admin/__tests__/auth.test.ts
// 后台鉴权闸门。三条要害：白名单空 = 全拒；非白名单 = 404（不是 403）；
// 未登录与非白名单的响应逐字同形（否则能拿它做管理员枚举）。
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';
import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { runMigrations } from '@/lib/db/migrate';
import { ADMIN_UIDS_ENV, adminUids, isAdminUid, requireAdmin } from '../auth';

let db: Db;
let admin: number;
let civilian: number;
const ORIGINAL = process.env[ADMIN_UIDS_ENV];

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  admin = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('boss@t.com').lastInsertRowid);
  civilian = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid);
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[ADMIN_UIDS_ENV];
  else process.env[ADMIN_UIDS_ENV] = ORIGINAL;
});

function req(token?: string, key?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;
  return new Request('http://localhost/api/v1/admin/users', { headers });
}

describe('白名单解析', () => {
  test('逗号分隔、去空格、去重、丢弃非正整数碎片', () => {
    expect(adminUids({ [ADMIN_UIDS_ENV]: ' 2, 17 ,2,, x, -3, 0,33 ' })).toEqual([2, 17, 33]);
  });

  test('未配置 / 空串 / 全是垃圾 → 空集（全拒，不是全放）', () => {
    expect(adminUids({})).toEqual([]);
    expect(adminUids({ [ADMIN_UIDS_ENV]: '' })).toEqual([]);
    expect(adminUids({ [ADMIN_UIDS_ENV]: ' , ,abc' })).toEqual([]);
    // 变异点：把空集当成通配（`uids.length === 0 → true`）会让这三条同时变绿
    expect(isAdminUid(2, {})).toBe(false);
    expect(isAdminUid(2, { [ADMIN_UIDS_ENV]: '' })).toBe(false);
  });

  test('只认整串数字，不做前缀/包含匹配（"2" 不该放行 uid=21）', () => {
    expect(isAdminUid(21, { [ADMIN_UIDS_ENV]: '2' })).toBe(false);
    expect(isAdminUid(2, { [ADMIN_UIDS_ENV]: '2' })).toBe(true);
  });
});

describe('requireAdmin', () => {
  test('白名单内 + 网页登录态 → 放行', () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const guard = requireAdmin(db, req(signToken(admin)));
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.identity.uid).toBe(admin);
  });

  test('ADMIN_UIDS 空 → 连本该是管理员的人也 404（全拒）', () => {
    process.env[ADMIN_UIDS_ENV] = '';
    const guard = requireAdmin(db, req(signToken(admin)));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  test('非白名单登录用户 → 404，不是 403', async () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const guard = requireAdmin(db, req(signToken(civilian)));
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(404);
      expect((await guard.response.json()).error_code).toBe('NOT_FOUND');
    }
  });

  test('未登录 与 非白名单 的响应逐字同形（状态码 + 响应体）', async () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const anon = requireAdmin(db, req());
    const outsider = requireAdmin(db, req(signToken(civilian)));
    expect(anon.ok).toBe(false);
    expect(outsider.ok).toBe(false);
    if (!anon.ok && !outsider.ok) {
      expect(anon.response.status).toBe(outsider.response.status);
      expect(await anon.response.json()).toEqual(await outsider.response.json());
    }
  });

  test('管理员本人的 api key 也 404：一把泄露的只读 key 不该能发钱', () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const key = generateApiKey();
    db.prepare('INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,?,?,?)')
      .run(admin, 'agent', hashApiKey(key), '["case:read"]');
    const guard = requireAdmin(db, req(undefined, key));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  test('伪造 token → 404', () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const guard = requireAdmin(db, req(`${signToken(admin)}x`));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  test('两次失败各自拿到可独立读取的 Response（不是共享单例）', async () => {
    process.env[ADMIN_UIDS_ENV] = String(admin);
    const a = requireAdmin(db, req());
    const b = requireAdmin(db, req());
    if (!a.ok && !b.ok) {
      expect((await a.response.json()).ok).toBe(false);
      expect((await b.response.json()).ok).toBe(false);
    }
  });
});
