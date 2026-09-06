// 「注册表驱动的 REST 端点」通线判据：真库、真迁移、真路由 handler，一处 mock 都没有。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 事实卡 / 诉求清单 / 新建行动卡 / 检索知识库 / 翻时间线这五条端点是这一轮新挂的，
// 它们不自己实现业务，而是回到能力注册表那一份去跑。接线写错的形态是：
// 路由把**别人的** uid 或写死的 caseId 交上去——响应 200、形状完全正常，
// 而返回的是另一个人的事实卡（那里面是当事人姓名、月薪、公司、全部诉求金额）。
//
// 变异臂：把任一路由里的 `runCapabilityRest(req, 'x', …)` 的能力名改掉、或让它
// 绕开 requireIdentity 自己拼 identity —— 下面的归属与权限两组当场红。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type CaseHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type PlainHandler = (req: Request) => Promise<Response>;

let getFacts: CaseHandler;
let getClaims: CaseHandler;
let postActions: CaseHandler;
let getTimeline: CaseHandler;
let searchKnowledge: PlainHandler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let caseB: number;

/** 甲案里的招牌串：乙的任何响应里出现它就算串号 */
const A_TITLE = '甲案·只有甲看得见的抬头';

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function req(auth?: string, url = 'http://localhost/api/v1/x', init: RequestInit = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(url, { ...init, headers });
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
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-restrunner-${crypto.randomUUID()}.db`);
  getFacts = (await import('@/app/api/v1/cases/[id]/facts/route')).GET;
  getClaims = (await import('@/app/api/v1/cases/[id]/claims/route')).GET;
  postActions = (await import('@/app/api/v1/cases/[id]/actions/route')).POST;
  getTimeline = (await import('@/app/api/v1/cases/[id]/timeline/route')).GET;
  searchKnowledge = (await import('@/app/api/v1/knowledge/search/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['claims', 'action_items', 'timeline_events', 'agent_writes', 'api_keys', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);

  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, district, created_at) VALUES (?, ?, '已收通知', '朝阳', '2026-08-19T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(userA, A_TITLE).lastInsertRowid);
  caseB = Number(insertCase.run(userB, '乙的案子').lastInsertRowid);
});

const CASE_ENDPOINTS: [string, () => CaseHandler, string][] = [
  ['GET /cases/{id}/facts', () => getFacts, 'case:read'],
  ['GET /cases/{id}/claims', () => getClaims, 'case:read'],
  ['GET /cases/{id}/timeline', () => getTimeline, 'case:read'],
];

describe('五条端点都存在', () => {
  test('路由文件导出了对应的 handler', () => {
    for (const h of [getFacts, getClaims, postActions, getTimeline, searchKnowledge]) {
      expect(typeof h).toBe('function');
    }
  });
});

describe('鉴权与权限（闸门在唯一入口，不靠各路由自觉抄一句）', () => {
  test.each(CASE_ENDPOINTS)('%s 无凭据 401', async (_name, handler) => {
    expect((await handler()(req(), ctx(caseA))).status).toBe(401);
  });

  test.each(CASE_ENDPOINTS)('%s 凭据缺 case:read ⇒ 403', async (_name, handler) => {
    const res = await handler()(req(issueKey(userA, ['case:write'])), ctx(caseA));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
  });

  test('POST /cases/{id}/actions 只读 key ⇒ 403（写能力不能被只读 key 调起）', async () => {
    const res = await postActions(
      req(issueKey(userA, ['case:read']), 'http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ items: [] }),
      }),
      ctx(caseA),
    );
    expect(res.status).toBe(403);
  });

  test('GET /knowledge/search 无凭据 401', async () => {
    expect((await searchKnowledge(req(undefined, 'http://localhost/x?query=补偿'))).status).toBe(
      401,
    );
  });
});

describe('归属：别人的案件当作不存在，且一个字都不漏', () => {
  test.each(CASE_ENDPOINTS)('%s：乙拿甲的 case_id ⇒ 404 且不含甲的任何招牌串', async (_n, h) => {
    const res = await h()(req(signToken(userB)), ctx(caseA));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(A_TITLE);
  });

  test('POST /cases/{id}/actions：乙往甲的案子里写 ⇒ 404，且甲案下没有多出行动卡', async () => {
    const res = await postActions(
      req(signToken(userB), 'http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ what: '交材料', how: '去窗口交', why: '不交会逾期', due_at: '2026-09-30T00:00:00.000Z' }],
        }),
      }),
      ctx(caseA),
    );
    expect(res.status).toBe(404);
    const count = db.prepare('SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?').get(caseA) as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  test.each(CASE_ENDPOINTS)('%s：非数字 id 当作不存在', async (_n, h) => {
    expect((await h()(req(signToken(userA)), ctx('demo'))).status).toBe(404);
  });
});

describe('本人调得通，且走的是注册表那一份实现', () => {
  test('事实卡回的是本案，且逐字带着案件抬头', async () => {
    const res = await getFacts(req(signToken(userA)), ctx(caseA));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; case_facts: string };
    expect(json.ok).toBe(true);
    expect(json.case_facts).toContain(A_TITLE);
  });

  test('诉求清单回 claims 与合计（合计由服务端给，不要调用方自己加）', async () => {
    const json = (await (await getClaims(req(signToken(userA)), ctx(caseA))).json()) as Record<
      string,
      unknown
    >;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.claims)).toBe(true);
    expect(json).toHaveProperty('total_fen');
  });

  test('新建行动卡真的落库，case_id 以路径为准（体里写别的编号不作数）', async () => {
    const res = await postActions(
      req(issueKey(userA, ['case:read', 'case:write']), 'http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({
          case_id: caseB,
          items: [{ what: '交材料', how: '去窗口交', why: '不交会逾期', due_at: '2026-09-30T00:00:00.000Z' }],
        }),
      }),
      ctx(caseA),
    );
    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT case_id FROM action_items').all() as { case_id: number }[];
    expect(rows.map((r) => r.case_id)).toEqual([caseA]);
  });

  test('时间线端点接受分页入参并回 events', async () => {
    const json = (await (
      await getTimeline(req(signToken(userA), 'http://localhost/x?limit=5&offset=0'), ctx(caseA))
    ).json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.events)).toBe(true);
  });

  test('知识检索空 query 回入参错误（而不是 500）', async () => {
    const res = await searchKnowledge(req(signToken(userA), 'http://localhost/x'));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_QUERY');
  });

  test('知识检索带 query 回 packs', async () => {
    const res = await searchKnowledge(
      req(signToken(userA), `http://localhost/x?query=${encodeURIComponent('经济补偿')}&limit=2`),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; packs: unknown[] };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.packs)).toBe(true);
    expect(json.packs.length).toBeLessThanOrEqual(2);
  });
});
