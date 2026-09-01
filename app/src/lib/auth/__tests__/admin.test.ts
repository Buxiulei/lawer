// app/src/lib/auth/__tests__/admin.test.ts
// ADMIN_UIDS 的解析 + 后台闸门。这一层看着像字符串处理，实际上它决定「谁能凭空造公道值」。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ADMIN_UIDS_ENV, adminUids, isAdminUid } from '../admin';

const env = (raw?: string) => (raw === undefined ? {} : { [ADMIN_UIDS_ENV]: raw });

describe('ADMIN_UIDS 解析', () => {
  test('逗号分隔、容忍空格', () => {
    expect(adminUids(env('2, 7 ,13'))).toEqual([2, 7, 13]);
    expect(isAdminUid(7, env('2, 7 ,13'))).toBe(true);
    expect(isAdminUid(8, env('2, 7 ,13'))).toBe(false);
  });

  test('没配 / 空串 / 全是分隔符 → 空集（谁都不是管理员）', () => {
    for (const raw of [undefined, '', '   ', ',,,', ' , ']) {
      expect(adminUids(env(raw)), `raw=${JSON.stringify(raw)}`).toEqual([]);
      expect(isAdminUid(2, env(raw))).toBe(false);
    }
  });

  /**
   * 【这条防的是 `Number('')===0`】用 Number 做宽松解析时，`ADMIN_UIDS=","` 里的空段
   * 会解出 0 并落进白名单。uid 0 现实中不存在（AUTOINCREMENT 从 1 起），
   * 所以这个洞不会让任何人真的登录成管理员——但它会让「配错了」和「配对了」在测试里同形。
   */
  test('垃圾值不入集：非纯数字、0、负数、小数、科学计数法一律丢弃', () => {
    expect(adminUids(env('2x, abc, 0, -1, 3.5, 1e3, , 2'))).toEqual([2]);
  });

  test('重复的 uid 只算一次', () => {
    expect(adminUids(env('2,2,7,2'))).toEqual([2, 7]);
  });

  test('默认读 process.env.ADMIN_UIDS', () => {
    const saved = process.env.ADMIN_UIDS;
    try {
      process.env.ADMIN_UIDS = '42';
      expect(isAdminUid(42)).toBe(true);
      expect(isAdminUid(43)).toBe(false);
      // 改 env 立刻生效（不缓存）：改了配置重启即可，不必怀疑是不是被某个模块冻住了
      process.env.ADMIN_UIDS = '43';
      expect(isAdminUid(42)).toBe(false);
      expect(isAdminUid(43)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_UIDS;
      else process.env.ADMIN_UIDS = saved;
    }
  });
});

/**
 * 闸门本身。三条拒绝理由（没凭据 / 不是网页登录态 / 不在白名单）在**响应上必须无法区分**，
 * 否则这个接口就成了一台后台存在性预言机。
 *
 * 其中 via!=='jwt' 那条是本轮补的洞：api key 是用户自己在设置页签发的长期凭据，
 * 管理员本人的一把 case:read key 若能走到签发面，就等于「一把泄露的只读 key 能发无限公道值」。
 */
describe('requireAdmin 闸门', () => {
  let db: Database;
  let requireAdmin: typeof import('../admin').requireAdmin;
  let signToken: (uid: number) => string;
  let generateApiKey: () => string;
  let hashApiKey: (k: string) => string;
  let resolveIdentity: typeof import('../identity').resolveIdentity;

  const saved = process.env.ADMIN_UIDS;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
    process.env.DB_PATH = path.join(os.tmpdir(), `lawer-adminguard-${crypto.randomUUID()}.db`);
    requireAdmin = (await import('../admin')).requireAdmin;
    signToken = (await import('../jwt')).signToken;
    const keys = await import('../api-key');
    generateApiKey = keys.generateApiKey;
    hashApiKey = keys.hashApiKey;
    resolveIdentity = (await import('../identity')).resolveIdentity;
    db = (await import('@/lib/db/client')).getDb();
  });

  beforeEach(() => {
    db.exec('DELETE FROM api_keys; DELETE FROM users;');
    if (saved === undefined) delete process.env.ADMIN_UIDS;
    else process.env.ADMIN_UIDS = saved;
  });

  const makeUser = (email: string) =>
    Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);

  function issueKey(userId: number, scopes: string[] = ['case:read', 'case:write']): string {
    const key = generateApiKey();
    db.prepare('INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled) VALUES (?, ?, ?, ?, 1)').run(
      userId,
      'k',
      hashApiKey(key),
      JSON.stringify(scopes),
    );
    return key;
  }

  const req = (token?: string) =>
    new Request('http://localhost/api/v1/admin/codes', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test('白名单里的网页登录态：放行，并交出 identity', () => {
    const uid = makeUser('admin@t.com');
    process.env.ADMIN_UIDS = String(uid);
    const r = requireAdmin(db, req(signToken(uid)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ uid, via: 'jwt' });
  });

  test('管理员本人的 api key：一样进不去（via 必须是 jwt）', async () => {
    const uid = makeUser('admin@t.com');
    process.env.ADMIN_UIDS = String(uid);
    const key = issueKey(uid);

    // 正对照：这把 key **确实有效**、确实解析成同一个管理员 uid。
    // 少了这条，「key 坏了所以被拒」与「key 好用但被 via 挡住」在断言上同形。
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${key}` }))).toMatchObject({
      uid,
      via: 'api_key',
    });

    const r = requireAdmin(db, req(key));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(404);
      expect(await r.response.text()).toBe(''); // 空体：与不存在的地址同形
    }
  });

  test('没凭据 / 白名单外 / 白名单空，一律 404', () => {
    const outsider = makeUser('outsider@t.com');
    process.env.ADMIN_UIDS = '999999';
    expect(requireAdmin(db, req()).ok).toBe(false);
    expect(requireAdmin(db, req(signToken(outsider))).ok).toBe(false);
    delete process.env.ADMIN_UIDS;
    expect(requireAdmin(db, req(signToken(outsider))).ok).toBe(false);
  });

  test('四种被拒的人拿到的响应逐字节相同 —— 从响应里读不出「你差在哪」', async () => {
    const uid = makeUser('admin@t.com');
    const outsider = makeUser('outsider@t.com');
    const key = issueKey(uid);
    process.env.ADMIN_UIDS = String(uid); // uid 在白名单里，只有 via 不对

    const shots: string[] = [];
    for (const token of [undefined, 'not.a.jwt', signToken(outsider), key]) {
      const r = requireAdmin(db, req(token));
      expect(r.ok).toBe(false);
      if (!r.ok) shots.push(`${r.response.status}|${await r.response.text()}`);
    }
    expect(shots).toHaveLength(4);
    expect(new Set(shots).size).toBe(1);
  });

  test('每次失败给的是新 Response —— 共享单例会在第二次读体时炸', async () => {
    process.env.ADMIN_UIDS = '999999';
    const a = requireAdmin(db, req());
    const b = requireAdmin(db, req());
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.response).not.toBe(b.response);
      await expect(a.response.text()).resolves.toBe('');
      await expect(b.response.text()).resolves.toBe('');
    }
  });
});
