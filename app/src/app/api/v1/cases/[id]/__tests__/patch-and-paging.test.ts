// PATCH /cases/{id} 的字段基本盘，与四条清单端点的分页。
//
// ─────────────── 这组补的是哪两个缺口 ───────────────
// ① PATCH 此前在路由里手抄了一份「可改字段」清单，只抄了 stage / goal / bottom_line。
//    能力那侧（case_update）早就收下用工基本盘四项，于是走 REST 的客户端传
//    monthly_wage_yuan 会拿到 **200 且 case 原样返回**——没有任何一处报错，那个值从来没落库。
//    援助律师 09-06 实测撞的就是这个。所以这里既验四项真落库，也用结构守卫钉住
//    「路由不许再有自己的字段清单」——只验行为的话，下一次有人把清单抄回来、抄全了，
//    判据照绿，而分叉从抄回来那天就重新开始了。
// ② 清单端点此前不分页：一次全给。回包里既没有 total 也没有 next_offset，
//    调用方无从知道自己拿到的是不是全部。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import crypto from 'node:crypto';
import os from 'node:os';
import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { factsCardFor } from '@/lib/agent';
import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { issueFactsToken } from '@/lib/cases/facts-token';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let patchCase: Handler;
let getEvidence: Handler;
let getActions: Handler;
let getDeadlines: Handler;
let getTimeline: Handler;
let db: Database;
let keyA: string;
let keyB: string;
let caseA: number;
let caseB: number;
let uidA: number;

const ROUTE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

function patch(body: unknown, key: string, id: number | string = caseA): Promise<Response> {
  return patchCase(
    new Request(`http://localhost/api/v1/cases/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
}

function list(handler: Handler, query: string, key = keyA, id: number | string = caseA) {
  return handler(
    new Request(`http://localhost/api/v1/cases/${id}/x${query}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    ctx(id),
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-patch-${crypto.randomUUID()}.db`);

  patchCase = (await import('../route')).PATCH;
  getEvidence = (await import('../evidence/route')).GET;
  getActions = (await import('../actions/route')).GET;
  getDeadlines = (await import('../deadlines/route')).GET;
  getTimeline = (await import('../timeline/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['agent_writes', 'api_keys', 'timeline_events', 'action_items', 'deadlines', 'evidence', 'files', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-09-01T00:00:00.000Z')",
  );
  uidA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  const uidB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-09-01T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(uidA, '甲的案子').lastInsertRowid);
  caseB = Number(insertCase.run(uidB, '乙的案子').lastInsertRowid);
  keyA = issueKey(uidA, ['case:read', 'case:write']);
  keyB = issueKey(uidB, ['case:read', 'case:write']);
});

// ========== ① PATCH 基本盘 ==========

describe('PATCH /cases/{id}：用工基本盘四项真落库', () => {
  test('四项一次传齐 → 200，且库里四列都变了（此前静默丢弃，回包还是 200）', async () => {
    const res = await patch(
      {
        employed_from: '2020-03-01',
        monthly_wage_yuan: 20000,
        position: '高级工程师',
        contract_count: '只签过一次',
      },
      keyA,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const row = db
      .prepare('SELECT employed_from, monthly_wage_fen, position, contract_count FROM cases WHERE id = ?')
      .get(caseA) as Record<string, unknown>;
    expect(row.employed_from).toBe('2020-03-01');
    // 元 → 分的换算与 MCP 那条路同一处（capabilities/shared 的 yuanToFen）
    expect(row.monthly_wage_fen).toBe(2_000_000);
    expect(row.position).toBe('高级工程师');
    expect(row.contract_count).toBe('只签过一次');
    // 回包与 MCP 同形：ok + case
    expect(body.case.monthly_wage_fen).toBe(2_000_000);
  });

  test('老三样照旧可改（不许为了加四项把原来的挤掉）', async () => {
    // stage 是高危入参：要带 facts_token（其余字段不必，见 registry.factsTokenArgs）
    const res = await patch(
      { stage: '已收通知', goal: '拿到 2N', bottom_line: '不低于 N+1', facts_token: issueFactsToken(factsCardFor(db, caseA)) },
      keyA,
    );
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT stage, goal, bottom_line FROM cases WHERE id = ?').get(caseA) as Record<string, unknown>;
    expect(row).toEqual({ stage: '已收通知', goal: '拿到 2N', bottom_line: '不低于 N+1' });
  });

  test('月薪非正数 → 400 INVALID_MONTHLY_WAGE 且零写入（校验与 MCP 同一处）', async () => {
    const res = await patch({ monthly_wage_yuan: -1 }, keyA);
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_MONTHLY_WAGE');
    expect(
      (db.prepare('SELECT monthly_wage_fen FROM cases WHERE id = ?').get(caseA) as { monthly_wage_fen: unknown })
        .monthly_wage_fen,
    ).toBeNull();
  });

  test('入职时间晚于今天 → 400 INVALID_EMPLOYED_FROM', async () => {
    const res = await patch({ employed_from: '2099-01-01' }, keyA);
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_EMPLOYED_FROM');
  });

  test('一个字段都不传 → 400 NO_FIELDS', async () => {
    const res = await patch({}, keyA);
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('NO_FIELDS');
  });

  test('乙改甲的案子 → 404 CASE_NOT_FOUND 且甲的档案一个字段没动', async () => {
    const res = await patch({ position: '被别人改的' }, keyB);
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
    expect(
      (db.prepare('SELECT position FROM cases WHERE id = ?').get(caseA) as { position: unknown }).position,
    ).toBeNull();
  });

  test('body 里塞别人的 case_id 也没用（路径段说了算）', async () => {
    const res = await patch({ case_id: caseB, position: '越权' }, keyA);
    expect(res.status).toBe(200);
    expect((db.prepare('SELECT position FROM cases WHERE id = ?').get(caseB) as { position: unknown }).position).toBeNull();
    expect((db.prepare('SELECT position FROM cases WHERE id = ?').get(caseA) as { position: unknown }).position).toBe('越权');
  });
});

/**
 * 结构守卫。变异臂：把 ../route.ts 的 PATCH 改回自己拼字段调 cases.updateCase ⇒ 本组红。
 * 只验行为的话，抄一份「抄全了的」字段清单回来照样全绿——而分叉是从抄回来那天开始的。
 */
describe('结构守卫：PATCH 走的是能力本体，不是路由里的第二份字段清单', () => {
  const source = fs.readFileSync(path.join(ROUTE_DIR, 'route.ts'), 'utf-8');

  test('引的是 lib/capabilities/invoke 的 invokeCapability，且点名 case_update', () => {
    expect(source).toMatch(/import\s*\{[^}]*\binvokeCapability\b[^}]*\}\s*from\s*'@\/lib\/capabilities\/invoke'/);
    expect(source).toContain("'case_update'");
  });

  test('路由里不再直接调 cases.updateCase（那是第二份字段清单的入口）', () => {
    expect(source).not.toMatch(/cases\.updateCase\s*\(/);
  });

  test('通用桥与本路由引的是同一个符号（不是两份同名实现）', () => {
    const bridge = fs.readFileSync(path.join(ROUTE_DIR, '..', '..', 'tools', '[name]', 'route.ts'), 'utf-8');
    expect(bridge).toMatch(/import\s*\{[^}]*\binvokeCapability\b[^}]*\}\s*from\s*'@\/lib\/capabilities\/invoke'/);
  });

  test('MCP 路由与桥共用同一份前置闸判定', () => {
    const mcp = fs.readFileSync(
      path.join(ROUTE_DIR, '..', '..', '..', 'mcp', 'route.ts'),
      'utf-8',
    );
    expect(mcp).toMatch(/import\s*\{[^}]*\bcheckPreconditions\b[^}]*\}\s*from\s*'@\/lib\/capabilities\/invoke'/);
    // 路由里不许再就地判一次实名——那就是第二份闸门
    expect(mcp).not.toContain('isRealnameVerified');
  });
});

// ========== ② 清单分页 ==========

function seedEvidence(n: number): void {
  for (let i = 0; i < n; i += 1) {
    const fileId = Number(
      db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1, 'image/jpeg', '/dev/null')")
        .run(crypto.randomUUID()).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO evidence (case_id, user_id, file_id, name, created_at) VALUES (?, ?, ?, ?, '2026-09-01T00:00:00.000Z')",
    ).run(caseA, uidA, fileId, `材料${i}`);
  }
}

function seedActions(n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      "INSERT INTO action_items (case_id, title, detail, status, created_at) VALUES (?, ?, '寄出并留底', '待办', '2026-09-01T00:00:00.000Z')",
    ).run(caseA, `行动${i}`);
  }
}

function seedDeadlines(n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      "INSERT INTO deadlines (case_id, kind, due_at, created_at) VALUES (?, '起诉15日', '2026-03-17T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
    ).run(caseA);
  }
}

function seedTimeline(n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      "INSERT INTO timeline_events (case_id, happened_at, kind, title, created_at) VALUES (?, ?, '公司动作', ?, '2026-09-01T00:00:00.000Z')",
    ).run(caseA, `2026-08-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`, `事件${i}`);
  }
}

const LISTS = [
  ['evidence', () => getEvidence, seedEvidence] as const,
  ['actions', () => getActions, seedActions] as const,
  ['deadlines', () => getDeadlines, seedDeadlines] as const,
  ['events', () => getTimeline, seedTimeline] as const,
];

describe('清单端点分页：total 是真总数，next_offset 只在真有下一页时给', () => {
  test.each(LISTS)('%s：3 条数据 limit=2 → 本页 2 条、total 3、next_offset 2', async (_legacyKey, handler, seed) => {
    seed(3);
    const body = await (await list(handler(), '?limit=2')).json();
    expect(body.items).toHaveLength(2);
    // 变异臂：把 total 写成本页条数 ⇒ 这一行红
    expect(body.total).toBe(3);
    expect(body.next_offset).toBe(2);
    expect(body.offset).toBe(0);
  });

  test.each(LISTS)('%s：翻到最后一页 next_offset 为 null，不是再翻一次才知道', async (_legacyKey, handler, seed) => {
    seed(3);
    const body = await (await list(handler(), '?limit=2&offset=2')).json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.next_offset).toBeNull();
    expect(body.offset).toBe(2);
  });

  test.each(LISTS)('%s：不传参数默认前 50 条，且 total 报的是全量', async (_legacyKey, handler, seed) => {
    seed(55);
    const body = await (await list(handler(), '')).json();
    expect(body.items).toHaveLength(50);
    expect(body.total).toBe(55);
    expect(body.next_offset).toBe(50);
  });

  test.each(LISTS)('%s：limit 超过 200 按 200 封顶（不是「你要多少给多少」）', async (_legacyKey, handler, seed) => {
    seed(205);
    const body = await (await list(handler(), '?limit=9999')).json();
    expect(body.items).toHaveLength(200);
    expect(body.total).toBe(205);
    expect(body.next_offset).toBe(200);
  });

  test.each(LISTS)('%s：旧键与 items 是同一批（页面读的是旧键，换名会让那一栏空掉且不报错）', async (legacyKey, handler, seed) => {
    seed(3);
    const body = await (await list(handler(), '')).json();
    expect(body[legacyKey as string]).toEqual(body.items);
  });

  test.each(LISTS)('%s：乙拿甲的 case_id 翻页 → 404，一条都不给', async (_legacyKey, handler, seed) => {
    seed(3);
    const res = await list(handler(), '?limit=2', keyB);
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
  });

  test('时间线的 since / kind 过滤后 total 跟着变（total 报的是过滤后的真总数）', async () => {
    seedTimeline(5);
    const body = await (await list(getTimeline, '?since=2026-08-03T00:00:00.000Z')).json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
  });
});
