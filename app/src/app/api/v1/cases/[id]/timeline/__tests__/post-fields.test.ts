// POST /api/v1/cases/{id}/timeline：**专用端点必须把说明书上写着的每一格都读进去。**
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 说明书里 `timeline_add` 的 REST 列指的就是本端点，而它与能力壳是**两份手写的入参映射**。
// 少读一格的形态是：调用方照说明书传了、回包 201、那一格在库里是 NULL——
// 没有一处报错，而下游按"这一格没填"办事。S4 的 `source_tier` 当年就是这么丢了一整段时间
//（路由注释里记着），本票的 `event_type` 是同一个形状的第二格。
//
// 【为什么两门那组判据盖不住这里】`src/app/api/__tests__/two-door-gate.test.ts` 打的两道门是
// `POST /api/mcp` 与通用桥 `POST /api/v1/tools/{name}`——**两条都走能力壳**。
// 本端点是第三条路，它自己抄了一份 body → 入参的映射。变异实测（2026-09-10/11）：
// 把本端点的 `eventType: body.event_type` 整行删掉，两门那组 15 条**全绿**。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-timeline-post-${crypto.randomUUID()}.db`);

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let post: Handler;
let db: Database;
let key: string;
let caseId: number;

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function add(body: Record<string, unknown>) {
  const res = await post(
    new Request(`http://localhost/api/v1/cases/${caseId}/timeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(caseId),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const rows = () =>
  db
    .prepare('SELECT title, source_tier, event_type FROM timeline_events WHERE case_id = ? ORDER BY id')
    .all(caseId);

beforeAll(async () => {
  post = (await import('../route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['agent_writes', 'timeline_events', 'api_keys', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const uid = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-09-01T00:00:00.000Z')",
      )
      .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '甲的案子', '风声', '2026-09-01T00:00:00.000Z')",
      )
      .run(uid).lastInsertRowid,
  );
  key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(uid, hashApiKey(key), JSON.stringify(['case:read', 'case:write']));
});

describe('专用端点把说明书上那几格都读进去', () => {
  const base = { happened_at: '2026-09-02T10:00:00+08:00', kind: '公司动作', title: '收到解除通知书' };
  /** 类型 id 逐字取自领域包：本文件不认识任何一个行当的取值。 */
  const TYPE_ID = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['公司动作'][0].id;

  test('🔴 event_type 与 source_tier 都真落库（变异：路由少读其中一格 → 红）', async () => {
    const res = await add({ ...base, source_tier: '书证', event_type: TYPE_ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(rows()).toEqual([
      { title: '收到解除通知书', source_tier: '书证', event_type: TYPE_ID },
    ]);
  });

  test('不传这两格 ⇒ 落最弱档 + 没选过类型（判定回落到读那段字）', async () => {
    expect((await add(base)).status).toBe(201);
    expect(rows()).toEqual([{ title: '收到解除通知书', source_tier: '自述', event_type: null }]);
  });

  test('🔴 非法 event_type ⇒ 400 INVALID_EVENT_TYPE，零写入，错误体列出这一类的允许值', async () => {
    const res = await add({ ...base, event_type: '我自己拼的一个值' });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('INVALID_EVENT_TYPE');
    expect(String(res.body.message)).toContain(TYPE_ID);
    expect(rows(), '被校验拦下时一行都不许落库').toEqual([]);
  });
});
