// app/src/app/api/v1/admin/codes/__tests__/route.test.ts
// 管理后台兑换码面。这里守的是**这条路由对外不存在**：
// 不在白名单的人拿到的东西，必须与随便敲一个不存在的地址完全一样（空体 404）。
// 403 或任何 error_code 都等于承认「这里有个后台，只是你进不去」——那正是值得撞的东西。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;

const savedAdminUids = process.env.ADMIN_UIDS;

function request(method: 'GET' | 'POST', token?: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/v1/admin/codes', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-admincodes-${crypto.randomUUID()}.db`);
  const mod = await import('../route');
  GET = mod.GET;
  POST = mod.POST;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM gongdao_ledger; DELETE FROM gongdao; DELETE FROM redemption_codes; DELETE FROM users;');
});

afterEach(() => {
  if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS;
  else process.env.ADMIN_UIDS = savedAdminUids;
});

function makeUser(email: string): number {
  return Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
}

/** 空体 404：状态、体、以及"体是空的"三样都要断言 */
async function expectNotThere(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe('');
}

describe('非白名单一律 404，不是 403', () => {
  test('没登录', async () => {
    process.env.ADMIN_UIDS = '2';
    await expectNotThere(await GET(request('GET')));
    await expectNotThere(await POST(request('POST', undefined, { count: 1, gongdao: 100 })));
  });

  test('登录了但不在白名单', async () => {
    process.env.ADMIN_UIDS = '2';
    const outsider = makeUser('outsider@t.com');
    // 正对照：这个 uid 确实不是 2，且 token 本身是有效的（下一条会用同样的手法进得去）
    expect(outsider).not.toBe(2);
    await expectNotThere(await GET(request('GET', signToken(outsider))));
    await expectNotThere(await POST(request('POST', signToken(outsider), { count: 1, gongdao: 100 })));
    // 越权的 POST 一张码都不许落库
    expect(db.prepare('SELECT COUNT(*) c FROM redemption_codes').get()).toEqual({ c: 0 });
  });

  test('token 伪造/过期', async () => {
    process.env.ADMIN_UIDS = '2';
    await expectNotThere(await GET(request('GET', 'not.a.jwt')));
  });

  test('ADMIN_UIDS 没配时连白名单里的人都进不去（默认空集，不是默认放行）', async () => {
    delete process.env.ADMIN_UIDS;
    const uid = makeUser('anyone@t.com');
    await expectNotThere(await GET(request('GET', signToken(uid))));
  });

  test('三种被拒的人拿到的响应逐字节相同 —— 从响应里读不出「你差在哪」', async () => {
    process.env.ADMIN_UIDS = '999999';
    const uid = makeUser('someone@t.com');
    const shots = await Promise.all(
      [undefined, 'not.a.jwt', signToken(uid)].map(async (t) => {
        const res = await GET(request('GET', t));
        return `${res.status}|${await res.text()}`;
      }),
    );
    expect(new Set(shots).size).toBe(1);
  });
});

describe('白名单内：列表与签发', () => {
  function asAdmin(): number {
    const uid = makeUser('admin@t.com');
    process.env.ADMIN_UIDS = String(uid);
    return uid;
  }

  test('签发一批：返回码列表，落库带面值/备注/签发人', async () => {
    const uid = asAdmin();
    const res = await POST(request('POST', signToken(uid), { count: 5, gongdao: 300, note: '国庆批' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; codes: string[] };
    expect(body.ok).toBe(true);
    expect(body.codes).toHaveLength(5);
    expect(new Set(body.codes).size).toBe(5);

    const rows = db.prepare('SELECT gongdao_value, note, created_by FROM redemption_codes').all() as {
      gongdao_value: number;
      note: string | null;
      created_by: number | null;
    }[];
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toEqual({ gongdao_value: 300, note: '国庆批', created_by: uid });
  });

  test('列表回全部码与状态字段，最新在前', async () => {
    const uid = asAdmin();
    await POST(request('POST', signToken(uid), { count: 2, gongdao: 100, note: 'A' }));
    await POST(request('POST', signToken(uid), { count: 1, gongdao: 200, note: 'B' }));
    const body = (await (await GET(request('GET', signToken(uid)))).json()) as {
      codes: { note: string; gongdao_value: number; redeemed_by: number | null }[];
    };
    expect(body.codes).toHaveLength(3);
    expect(body.codes[0].note).toBe('B');
    expect(body.codes[0].gongdao_value).toBe(200);
    expect(body.codes[0].redeemed_by).toBeNull();
  });

  test('张数与面值的守卫：0 / 负数 / 超批量上限 / 非整数一律拒，且一张都不落库', async () => {
    const uid = asAdmin();
    const bad = [
      { count: 0, gongdao: 100 },
      { count: -1, gongdao: 100 },
      { count: 501, gongdao: 100 },
      { count: 1.5, gongdao: 100 },
      { count: 5, gongdao: 0 },
      { count: 5, gongdao: -100 },
    ];
    for (const body of bad) {
      const res = await POST(request('POST', signToken(uid), body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM redemption_codes').get()).toEqual({ c: 0 });
  });

  test('到期时间：ISO 入参落成 canonical 串；解不出来就报错，不静默当作永不过期', async () => {
    const uid = asAdmin();
    const ok = await POST(
      request('POST', signToken(uid), { count: 1, gongdao: 100, expires_at: '2026-12-31T00:00:00Z' }),
    );
    expect(ok.status).toBe(200);
    const stored = (db.prepare('SELECT expires_at e FROM redemption_codes').get() as { e: string }).e;
    expect(stored).toBe('2026-12-31 00:00:00'); // 库里只存 canonical（ADR-002）
    expect(stored).not.toContain('T');

    const bad = await POST(request('POST', signToken(uid), { count: 1, gongdao: 100, expires_at: '不是日期' }));
    expect(bad.status).toBe(400);
    // 关键：**没有**多出一张永久码。静默吞掉解析失败会让一批限时码变成永久码。
    expect(db.prepare('SELECT COUNT(*) c FROM redemption_codes').get()).toEqual({ c: 1 });
  });

  test('留空到期＝不过期（存 NULL，不编一个默认到期日）', async () => {
    const uid = asAdmin();
    await POST(request('POST', signToken(uid), { count: 1, gongdao: 100, expires_at: '' }));
    expect(db.prepare('SELECT expires_at e FROM redemption_codes').get()).toEqual({ e: null });
  });
});
