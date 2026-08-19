// app/src/app/api/v1/cases/__tests__/route.test.ts
// REST 面与 MCP 面走同一批 lib/cases 函数，这里验两件事：
// ① 路由自己的壳（路径参数、query、scope 闸门、错误形状）对；
// ② 同一个操作从 REST 走和从 MCP 走结果一致——两条入口不能悄悄分叉。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type CaseHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type ActionHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string; actionId: string }> },
) => Promise<Response>;

let getCase: CaseHandler;
let patchCase: CaseHandler;
let postTimeline: CaseHandler;
let getActions: CaseHandler;
let patchAction: ActionHandler;
let getDeadlines: CaseHandler;
let getEvidence: CaseHandler;
let mcpPost: (req: Request) => Promise<Response>;
let getManifest: () => Promise<Response>;

let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let actionA: number;

function request(method: string, auth?: string, body?: unknown, query = ''): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://localhost/api/v1/cases/1${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

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
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-cases-${crypto.randomUUID()}.db`);

  const caseRoute = await import('../[id]/route');
  getCase = caseRoute.GET;
  patchCase = caseRoute.PATCH;
  postTimeline = (await import('../[id]/timeline/route')).POST;
  getActions = (await import('../[id]/actions/route')).GET;
  patchAction = (await import('../[id]/actions/[actionId]/route')).PATCH;
  getDeadlines = (await import('../[id]/deadlines/route')).GET;
  getEvidence = (await import('../[id]/evidence/route')).GET;
  mcpPost = (await import('@/app/api/mcp/route')).POST;
  getManifest = (await import('@/app/api/manifest/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['api_keys', 'timeline_events', 'action_items', 'deadlines', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
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
  actionA = Number(
    db
      .prepare(
        "INSERT INTO action_items (case_id, title, status, priority, created_at) VALUES (?, '打社保记录', '待办', 1, '2026-08-19T00:00:00.000Z')",
      )
      .run(caseA).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO deadlines (case_id, kind, due_at, created_at) VALUES (?, '仲裁时效', '2027-08-01T00:00:00.000Z', '2026-08-19T00:00:00.000Z')",
  ).run(caseA);
});

describe('读接口', () => {
  test('GET 案件 / 行动卡 / 期限 / 证据都通', async () => {
    const token = signToken(userA);

    const detail = await (await getCase(request('GET', token), ctx(caseA))).json();
    expect(detail).toMatchObject({ ok: true, case: { title: '甲的案子' }, timeline: [] });

    const actions = await (await getActions(request('GET', token), ctx(caseA))).json();
    expect(actions.actions).toHaveLength(1);

    const deadlines = await (await getDeadlines(request('GET', token), ctx(caseA))).json();
    expect(deadlines.deadlines[0].kind).toBe('仲裁时效');

    const evidence = await (await getEvidence(request('GET', token), ctx(caseA))).json();
    expect(evidence).toMatchObject({ ok: true, evidence: [] });
  });

  test('?status= 过滤行动卡', async () => {
    const token = signToken(userA);
    const res = await getActions(request('GET', token, undefined, '?status=完成'), ctx(caseA));
    expect((await res.json()).actions).toEqual([]);

    const bad = await getActions(request('GET', token, undefined, '?status=done'), ctx(caseA));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe('INVALID_STATUS');
  });
});

describe('写接口', () => {
  test('PATCH 改档案、POST 加时间线、PATCH 完成行动卡', async () => {
    const token = signToken(userA);

    const patched = await patchCase(request('PATCH', token, { stage: '已收通知', goal: '拿 2N' }), ctx(caseA));
    expect((await patched.json()).case).toMatchObject({ stage: '已收通知', goal: '拿 2N' });

    const added = await postTimeline(
      request('POST', token, {
        happened_at: '2026-08-15T09:30:00+08:00',
        kind: '公司动作',
        title: 'HR 约谈',
      }),
      ctx(caseA),
    );
    expect(added.status).toBe(201);
    expect((await added.json()).event.happened_at).toBe('2026-08-15 01:30:00');

    const done = await patchAction(request('PATCH', token), {
      params: Promise.resolve({ id: String(caseA), actionId: String(actionA) }),
    });
    expect((await done.json()).action.status).toBe('完成');
  });
});

describe('鉴权与红线', () => {
  test('无凭据 → 401', async () => {
    expect((await getCase(request('GET'), ctx(caseA))).status).toBe(401);
  });

  test('只读 key 调 PATCH → 403 FORBIDDEN_SCOPE', async () => {
    const readOnly = issueKey(userA, ['case:read']);
    const res = await patchCase(request('PATCH', readOnly, { stage: '已解除' }), ctx(caseA));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
    // 读仍然可以
    expect((await getCase(request('GET', readOnly), ctx(caseA))).status).toBe(200);
  });

  test('【红线】乙访问甲的案件 → 404，与不存在的案件返回完全相同', async () => {
    const tokenB = signToken(userB);
    const notMine = await getCase(request('GET', tokenB), ctx(caseA));
    const missing = await getCase(request('GET', tokenB), ctx(999999));
    expect(notMine.status).toBe(404);
    expect(await notMine.json()).toEqual(await missing.json());
  });

  test('路径 id 是垃圾字符串时按不存在处理，不炸', async () => {
    const res = await getCase(request('GET', signToken(userA)), {
      params: Promise.resolve({ id: '../../etc/passwd' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('REST 与 MCP 两条入口行为一致', () => {
  test('同一个 case_get，REST 与 MCP 返回同样的档案数据', async () => {
    const key = issueKey(userA, ['case:read', 'case:write']);

    const rest = await (await getCase(request('GET', key), ctx(caseA))).json();

    const mcpRes = await mcpPost(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'case_get', arguments: { case_id: caseA } },
        }),
      }),
    );
    const mcpPayload = JSON.parse((await mcpRes.json()).result.content[0].text);

    expect(mcpPayload.case).toEqual(rest.case);
    expect(mcpPayload.timeline).toEqual(rest.timeline);
  });
});

describe('/api/manifest', () => {
  test('公开无鉴权，且不含任何账号或案件数据', async () => {
    const body = await (await getManifest()).json();
    expect(body.name).toBe('lawer-caiyuan');
    expect(body.mcp.endpoint).toBe('/api/mcp');
    expect(body.auth.scopes).toEqual(['case:read', 'case:write']);

    const text = JSON.stringify(body);
    expect(text).not.toContain('甲的案子');
    expect(text).not.toContain('phone');
    expect(text).not.toContain('key_hash');
  });

  test('manifest 里的工具清单与 tools/list 完全一致', async () => {
    const key = issueKey(userA, ['case:read']);
    const manifest = await (await getManifest()).json();
    const mcpRes = await mcpPost(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const listed = (await mcpRes.json()).result.tools.map((t: { name: string }) => t.name);
    expect(manifest.mcp.tools.map((t: { name: string }) => t.name)).toEqual(listed);
  });
});
