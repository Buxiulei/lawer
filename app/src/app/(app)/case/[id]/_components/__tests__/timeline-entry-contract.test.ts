// 站内「记一件事 / 选类型」那两张表单发出去的**那份请求体，真端点收得下**。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 前端的 body 与后端读的字段名是**两份手写的映射**（三条写入路径各一份，见
// api/v1/cases/[id]/timeline/__tests__/post-fields.test.ts 抬头）。前端把 `happened_at`
// 拼成 `happenedAt` 的形态是：请求发出去、回包 400/201 取决于哪一格错了，
// 而最糟的一种是**错的那一格恰好是可选的** —— 回包 201、页面上那条记录立刻出现，
// 库里那一格却是 NULL，没有一处报错。
// 所以这里不造替身端点：`@/app/_ui/api` 的 apiFetch 被换成"把这份体喂给真路由"，
// 断言落在**库里那一行**上。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-timeline-contract-${crypto.randomUUID()}.db`);

/** 真路由的入口，在 beforeAll 里填进来（vi.mock 的工厂被提升，拿不到 import 结果） */
const routes = vi.hoisted(() => ({
  get: null as ((req: Request, ctx: unknown) => Promise<Response>) | null,
  post: null as ((req: Request, ctx: unknown) => Promise<Response>) | null,
  patch: null as ((req: Request, ctx: unknown) => Promise<Response>) | null,
  token: '',
}));

vi.mock('@/app/_ui/api', async () => {
  const actual = await vi.importActual<typeof import('@/app/_ui/api')>('@/app/_ui/api');
  return {
    ...actual,
    /** 前端那一层照常调 apiFetch，只是这次它通到真路由，而不是网络 */
    apiFetch: async (p: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET';
      const req = new Request(`http://localhost/api/v1${p}`, {
        method,
        headers: {
          authorization: `Bearer ${routes.token}`,
          'content-type': 'application/json',
        },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      // 路径 → 哪条路由 + 路径参数。前端拼的就是这几条，拼错了这里当场抛。
      const m = /^\/cases\/(\d+)(?:\/timeline(?:\/(\d+))?)?(?:\?|$)/.exec(p);
      if (!m) throw new Error(`前端拼出了一条没有人认识的路径：${p}`);
      const ctx = { params: Promise.resolve({ id: m[1], eventId: m[2] ?? '' }) };
      const handler =
        method === 'POST' ? routes.post : method === 'PATCH' ? routes.patch : routes.get;
      const res = await handler!(req, ctx);
      const payload = (await res.json()) as { ok?: boolean; message?: string; error_code?: string };
      if (!res.ok || payload.ok === false) {
        throw new actual.ApiError(
          payload.error_code ?? `HTTP_${res.status}`,
          payload.message ?? '',
          res.status,
        );
      }
      return payload;
    },
  };
});

const { createEvent, fetchTimeline, setEventType } = await import('../timelineData');
const { ApiError, humanError } = await import('@/app/_ui/api');
const { signToken } = await import('@/lib/auth/jwt');
const { DEFAULT_DOMAIN, DOMAINS } = await import('@/lib/domains/registry');

/** 类型 id / label 逐字取自领域包：本文件不认识任何一个行当的取值。 */
const COMPANY_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['公司动作'];

let db: Database;
let caseId: number;

const rows = () =>
  db
    .prepare(
      'SELECT happened_at, kind, title, detail, source_tier, asserted_by, event_type' +
        ' FROM timeline_events WHERE case_id = ? ORDER BY id',
    )
    .all(caseId);

beforeAll(async () => {
  routes.get = (await import('@/app/api/v1/cases/[id]/route')).GET as typeof routes.get;
  routes.post = (await import('@/app/api/v1/cases/[id]/timeline/route')).POST as typeof routes.post;
  routes.patch = (await import('@/app/api/v1/cases/[id]/timeline/[eventId]/route'))
    .PATCH as typeof routes.patch;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['agent_writes', 'timeline_events', 'cases', 'users']) {
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
  routes.token = signToken(uid);
});

describe('「记一件事」发出去的体', () => {
  test('🔴 五格逐格落库（变异：把 happened_at 拼成 happenedAt、或漏传 event_type → 红）', async () => {
    const created = await createEvent(String(caseId), {
      kind: '公司动作',
      happenedAt: '2026-09-02',
      title: '收到一份通知',
      detail: '当面给的',
      eventType: COMPANY_TYPES[0].id,
    });

    expect(rows()).toEqual([
      {
        happened_at: '2026-09-02 00:00:00',
        kind: '公司动作',
        title: '收到一份通知',
        detail: '当面给的',
        // 表单不让用户选档位，服务端缺省成最弱的那一档
        source_tier: '自述',
        // 网页登录态写的就是用户本人
        asserted_by: 'user',
        event_type: COMPANY_TYPES[0].id,
      },
    ]);
    // 回包那一行原样转成视图（头插用的是它，不是表单里那份草稿）
    expect(created.title).toBe('收到一份通知');
    expect(created.eventType).toBe(COMPANY_TYPES[0].id);
    expect(created.sourceTier).toBe('自述');
  });

  test('不选类型 / 不写经过 ⇒ 那两格落 NULL，记录照样存得下', async () => {
    await createEvent(String(caseId), {
      kind: '我方动作',
      happenedAt: '2026-09-03',
      title: '回了一封信',
      detail: '   ',
      eventType: null,
    });
    expect(rows()).toEqual([
      expect.objectContaining({ kind: '我方动作', detail: null, event_type: null }),
    ]);
  });

  test('🔴 取值非法时，错误体里那份允许值清单一路传到界面上那句话', async () => {
    const err = await createEvent(String(caseId), {
      kind: '公司动作',
      happenedAt: '2026-09-02',
      title: '收到一份通知',
      detail: '',
      eventType: '我自己拼的一个值',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    // **摆在抽屉里的就是 humanError 的返回值**（见 TimelineEntrySheet 的 catch）。
    // 变异：把 INVALID_EVENT_TYPE 加进 api.ts 的 COPY 表换成一句通用话 → 这一条红，
    // 因为那份 id + label 的清单正是用户挑不准时唯一能照着选的东西。
    const shown = humanError(err);
    for (const t of COMPANY_TYPES) {
      expect(shown).toContain(t.id);
      expect(shown).toContain(t.label);
    }
    expect(rows(), '被校验拦下时一行都不许落库').toEqual([]);
  });
});

describe('「选类型」发出去的体', () => {
  test('🔴 PATCH 路径与字段名对得上，且只动 event_type（变异：路径少一段 → 当场抛）', async () => {
    const created = await createEvent(String(caseId), {
      kind: '公司动作',
      happenedAt: '2026-09-02',
      title: '收到一份通知',
      detail: '当面给的',
      eventType: null,
    });
    const updated = await setEventType(String(caseId), created.id, COMPANY_TYPES[1].id);

    expect(updated.eventType).toBe(COMPANY_TYPES[1].id);
    expect(rows()).toEqual([
      expect.objectContaining({
        title: '收到一份通知',
        detail: '当面给的',
        event_type: COMPANY_TYPES[1].id,
      }),
    ]);
  });
});

describe('读侧', () => {
  test('🔴 列表读回来的每条都带着档位与类型两格（变异：GET 少读一格 → 这里读成 null）', async () => {
    await createEvent(String(caseId), {
      kind: '公司动作',
      happenedAt: '2026-09-02',
      title: '收到一份通知',
      detail: '',
      eventType: COMPANY_TYPES[0].id,
    });
    const list = await fetchTimeline(String(caseId));
    expect(list).toHaveLength(1);
    expect(list[0].eventType).toBe(COMPANY_TYPES[0].id);
    expect(list[0].sourceTier).toBe('自述');
    expect(list[0].kind).toBe('公司动作');
  });
});
