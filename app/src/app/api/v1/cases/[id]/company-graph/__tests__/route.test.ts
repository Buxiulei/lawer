// app/src/app/api/v1/cases/[id]/company-graph/__tests__/route.test.ts
// 路由壳：scope 闸门、归属红线、以及「查不到＝null 不是错」这条约定。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getGraph: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function request(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/company-graph', { headers });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-cgraph-${crypto.randomUUID()}.db`);

  getGraph = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of [
    'company_watch_events',
    'company_watches',
    'company_litigation',
    'company_relations',
    'company_profiles',
    'api_keys',
    'cases',
    'users',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '甲的案子', '风声', '2026-08-19T00:00:00.000Z')",
      )
      .run(userA).lastInsertRowid,
  );
});

describe('GET company-graph', () => {
  test('还没做过公司调查 ⇒ ok:true 且 graph 为 null（不是 404、不是错误）', async () => {
    const res = await getGraph(request(signToken(userA)), ctx(caseA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, graph: null });
  });

  test('有主体时按契约形状返回', async () => {
    db.prepare(
      `INSERT INTO company_profiles (case_id, name, role, uscc, created_at)
       VALUES (?, '甲公司', '用工主体', '91110000X', '2026-08-19T00:00:00.000Z')`,
    ).run(caseA);

    const body = await (await getGraph(request(signToken(userA)), ctx(caseA))).json();
    expect(body.ok).toBe(true);
    expect(body.graph.nodes).toHaveLength(1);
    expect(body.graph.nodes[0]).toMatchObject({
      name: '甲公司',
      role: '用工主体',
      creditCode: '91110000X',
      tier: 3,
    });
    expect(Object.keys(body.graph)).toEqual(['meta', 'nodes', 'edges', 'events']);
  });

  /**
   * 归属红线：别人的案件一律当作**不存在**，不给 403。
   * 变异臂：把路由里的 cases.getCase 归属校验去掉直接 build，这条会红——
   * 而且它红的方式正是我们最怕的那种：另一个用户的公司关系被原样返回。
   */
  test('别人的案件返回 CASE_NOT_FOUND，且不泄漏任何图谱内容', async () => {
    db.prepare(
      `INSERT INTO company_profiles (case_id, name, role, created_at)
       VALUES (?, '甲公司', '用工主体', '2026-08-19T00:00:00.000Z')`,
    ).run(caseA);

    const res = await getGraph(request(signToken(userB)), ctx(caseA));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: 'CASE_NOT_FOUND' });
    expect(JSON.stringify(body)).not.toContain('甲公司');
  });

  test('非数字 id 当作不存在', async () => {
    const res = await getGraph(request(signToken(userA)), ctx('demo'));
    expect(res.status).toBe(404);
  });

  test('无凭据 401', async () => {
    expect((await getGraph(request(), ctx(caseA))).status).toBe(401);
  });

  test('凭据缺 case:read 时不放行', async () => {
    const key = issueKey(userA, ['case:write']);
    const res = await getGraph(request(key), ctx(caseA));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBe(false);
  });
});
