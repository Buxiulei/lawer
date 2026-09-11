// PATCH /api/v1/cases/{id}/timeline/{eventId}：**时间线上唯一可改的那一列**。
//
// ─────────────── 这组在守什么 ───────────────
// 时间线只追加不改删（migrate.ts 建表注释：可改即等于可篡改，庭上无法自证）。
// 本端点是那条纪律上唯一的口子：event_type 是**分类标签**，不断言发生过什么。
// 口子一旦开歪，坏法是静默的：
//   ① 顺手多收一个字段 ⇒ 标题/日期变成可改的，而回包 200、页面照常；
//   ② 开给 api key ⇒ 模型读完那段自述替用户把类型定了，而要件判定**优先读这一格**、
//      不再回落到谓词——归类从此压过服务端的判定，且库里看不出是人选的还是模型填的；
//   ③ 值域校验绕过 ⇒ 库里躺着一个谁都不认的取值，判定对它既不按类型走、也不回落。
// 三种都不报错，所以逐条钉在这里。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-timeline-patch-${crypto.randomUUID()}.db`);

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

type Handler = (
  req: Request,
  ctx: { params: Promise<{ id: string; eventId: string }> },
) => Promise<Response>;

let patch: Handler;
let db: Database;
let jwt: string;
let apiKey: string;
let uid: number;
let caseId: number;
let eventId: number;

/** 类型 id / label 逐字取自领域包：本文件不认识任何一个行当的取值。 */
const COMPANY_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['公司动作'];
const MINE_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['我方动作'];

async function call(
  body: unknown,
  opts: { token?: string; caseId?: number; eventId?: number } = {},
) {
  const cid = opts.caseId ?? caseId;
  const eid = opts.eventId ?? eventId;
  const res = await patch(
    new Request(`http://localhost/api/v1/cases/${cid}/timeline/${eid}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${opts.token ?? jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(cid), eventId: String(eid) }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 那一行此刻**全部**要紧的列。改了不该改的，这张表当场对不上。 */
const row = () =>
  db
    .prepare(
      'SELECT happened_at, kind, title, detail, source_tier, asserted_by, event_type,' +
        ' event_type_set_at FROM timeline_events WHERE id = ?',
    )
    .get(eventId);

beforeAll(async () => {
  patch = (await import('../route')).PATCH;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['agent_writes', 'timeline_events', 'api_keys', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  uid = Number(
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
  eventId = Number(
    db
      .prepare(
        "INSERT INTO timeline_events (case_id, happened_at, kind, title, detail, source_tier, asserted_by)" +
          " VALUES (?, '2026-09-02 10:00:00', '公司动作', '收到一份通知', '当面给的', '自述', 'user')",
      )
      .run(caseId).lastInsertRowid,
  );
  jwt = signToken(uid);
  apiKey = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(uid, hashApiKey(apiKey), JSON.stringify(['case:read', 'case:write']));
});

describe('补选类型', () => {
  test('🔴 只改 event_type 这一列，其余七列一个字都不动（变异：SQL 里多列一格 → 红）', async () => {
    const before = row();
    const res = await call({ event_type: COMPANY_TYPES[0].id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = row() as Record<string, unknown>;
    expect(after.event_type).toBe(COMPANY_TYPES[0].id);
    // 这一次改动留了时间戳；除它与 event_type 之外，逐列与改之前逐字相等
    expect(after.event_type_set_at, '补选的那一刻要留得下来').toEqual(expect.any(String));
    expect({ ...after, event_type: null, event_type_set_at: null }).toEqual({
      ...(before as Record<string, unknown>),
      event_type: null,
      event_type_set_at: null,
    });
  });

  test('空串 = 取消这一格（回到"没人说过这是什么"，判定重新回落到谓词）', async () => {
    await call({ event_type: COMPANY_TYPES[0].id });
    const res = await call({ event_type: '' });
    expect(res.status).toBe(200);
    expect((row() as { event_type: string | null }).event_type).toBeNull();
  });
});

describe('口子不许开歪', () => {
  test('🔴 body 带 title ⇒ 400 IMMUTABLE_FIELD，库里一个字都不变（变异：改成静默忽略 → 红）', async () => {
    const before = row();
    const res = await call({ event_type: COMPANY_TYPES[0].id, title: '我改一下标题' });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('IMMUTABLE_FIELD');
    expect(String(res.body.message), '错误体要点名是哪一格越界了').toContain('title');
    expect(row(), '被拦下时连 event_type 也不许落').toEqual(before);
  });

  test('🔴 api key 调用 ⇒ 403 WEB_SESSION_REQUIRED，零写入（变异：换成 requireIdentity 就放行 → 红）', async () => {
    const before = row();
    const res = await call({ event_type: COMPANY_TYPES[0].id }, { token: apiKey });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('WEB_SESSION_REQUIRED');
    expect(row()).toEqual(before);
  });

  test('🔴 非法取值 ⇒ 400 INVALID_EVENT_TYPE，错误体列出这一类的 id 与 label，零写入', async () => {
    const before = row();
    const res = await call({ event_type: '我自己拼的一个值' });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('INVALID_EVENT_TYPE');
    // 与登记那条端点同形：允许值连同它们的说法一起列出来（post-fields.test.ts 同款断言）
    for (const t of COMPANY_TYPES) {
      expect(String(res.body.message)).toContain(t.id);
      expect(String(res.body.message)).toContain(t.label);
    }
    expect(row()).toEqual(before);
  });

  test('🔴 值域按**这一行自己的 kind** 取：别的类别下的取值一样被拒', async () => {
    const res = await call({ event_type: MINE_TYPES[0].id });
    expect(res.status, '「我方动作」的取值不该落到一条「公司动作」上').toBe(400);
    expect(res.body.error_code).toBe('INVALID_EVENT_TYPE');
    expect((row() as { event_type: string | null }).event_type).toBeNull();
  });

  test('一个字段都不带 ⇒ 400 NO_FIELDS，不按"清空"办', async () => {
    await call({ event_type: COMPANY_TYPES[0].id });
    const res = await call({});
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('NO_FIELDS');
    expect(
      (row() as { event_type: string | null }).event_type,
      '漏拼一个字段不该把已经选好的类型悄悄抹掉',
    ).toBe(COMPANY_TYPES[0].id);
  });
});

describe('归属', () => {
  test('🔴 别人的案件 ⇒ 与既有归属错误同形（CASE_NOT_FOUND / 404，不回 403）', async () => {
    const otherUid = Number(
      db
        .prepare(
          "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-09-01T00:00:00.000Z')",
        )
        .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
    );
    const res = await call(
      { event_type: COMPANY_TYPES[0].id },
      { token: signToken(otherUid) },
    );
    expect(res.status).toBe(404);
    expect(res.body.error_code, '403 等于承认这个案件号有效').toBe('CASE_NOT_FOUND');
    expect((row() as { event_type: string | null }).event_type).toBeNull();
  });

  test('事件不在本案下 ⇒ 404 EVENT_NOT_FOUND', async () => {
    const res = await call({ event_type: COMPANY_TYPES[0].id }, { eventId: eventId + 999 });
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('EVENT_NOT_FOUND');
  });
});

describe('台账', () => {
  test('这条路不记 agent_writes：它只认网页登录态，那张台账记的是 agent 经 API 写了什么', async () => {
    await call({ event_type: COMPANY_TYPES[0].id });
    const n = db.prepare('SELECT COUNT(*) AS n FROM agent_writes').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
