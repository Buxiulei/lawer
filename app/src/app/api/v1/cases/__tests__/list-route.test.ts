// app/src/app/api/v1/cases/__tests__/list-route.test.ts
// GET /api/v1/cases —— 「我的案件是哪一个」全站唯一的真相来源。
//
// 这条接口不存在的那段时间里，前端三处各自把答案写死成 demo，
// 产品唯一的真实用户于是刷新一次首页就落进演示案件。所以这里验的不只是"能返回"，
// 还有**别人的案件一条都不许出现**、**空清单要能与查不到区分开**。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

let listCases: (req: Request) => Promise<Response>;
let db: Database;
let userA: number;
let userB: number;

function request(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases', { method: 'GET', headers });
}

function insertCase(userId: number, title: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-19T00:00:00.000Z')",
      )
      .run(userId, title).lastInsertRowid,
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-caselist-${crypto.randomUUID()}.db`);

  listCases = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['api_keys', 'timeline_events', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
});

describe('名下案件清单', () => {
  test('回自己的案件，新的在前', async () => {
    insertCase(userA, '第一个案子');
    const newer = insertCase(userA, '第二个案子');

    const body = await (await listCases(request(signToken(userA)))).json();
    expect(body.ok).toBe(true);
    expect(body.cases.map((c: { title: string }) => c.title)).toEqual(['第二个案子', '第一个案子']);
    // 解析页取的就是数组头，所以"头是最新那个"这件事必须钉住
    expect(body.cases[0].id).toBe(newer);
  });

  test('别人的案件一条都不出现', async () => {
    insertCase(userA, '甲的案子');
    insertCase(userB, '乙的案子');

    const body = await (await listCases(request(signToken(userA)))).json();
    expect(body.cases).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('乙的案子');
  });

  test('名下没有案件回 200 + 空清单——"没有"和"没查到"必须是两种响应', async () => {
    const res = await listCases(request(signToken(userA)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cases: [] });
  });

  test('没凭据回 401，不是空清单', async () => {
    const res = await listCases(request());
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('UNAUTHORIZED');
  });

  test('凭据没有 case:read 权限回 403', async () => {
    const key = generateApiKey();
    db.prepare(
      "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
    ).run(userA, hashApiKey(key), JSON.stringify(['case:write']));

    const res = await listCases(request(key));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
  });

  test('响应里带标题，解析页才能不靠再查一次就写缓存', async () => {
    insertCase(userA, '我的案件');
    const body = await (await listCases(request(signToken(userA)))).json();
    expect(body.cases[0]).toMatchObject({ title: '我的案件', stage: '风声' });
  });
});
