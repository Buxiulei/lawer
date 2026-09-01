// app/src/app/api/v1/cases/[id]/drafts/__tests__/route.test.ts
// 文书列表端点的**通线**判据：真库、真迁移、真路由 handler，一处 mock 都没有。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 文书页 2026-09-01 从 mock 切到真数据，新端点 GET /cases/{id}/drafts 就此上线。
// 它此前**一条自己的判据都没有**：lib 层那侧有归属红线（lib/cases 的 listDrafts），
// 页面那侧有画法判据（case/[id]/__tests__/docs-drafts-real-data），
// 但**中间这一段接线没人验**——路由把哪个 userId、哪个 caseId 交给 lib，全凭它自己写对。
// 于是把 `{ caseId, userId: guard.identity.uid }` 写死成 `{ caseId: 1, userId: 1 }`，
// 整套判据仍然全绿，而线上每一个人打开文书页读到的都是 1 号用户 1 号案件的文书。
//
// 文书正文里是主张金额、对公司的措辞、要递给仲裁委的原话——**串号一次就是正文级泄漏**，
// 比证据串号更直接（证据还只是文件名，文书是逐字的话）。所以这组从 handler 本体起跑：
//   变异臂：把 ../route.ts 删掉 —— 下面 beforeAll 的 import 当场失败，整组红。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getDrafts: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let caseB: number;

/** 甲案里那份文书的招牌串：乙的响应里出现任何一个字都算串号 */
const A_TITLE = '甲的仲裁申请书';
const A_BODY = '甲要求恒昇科技支付违法解除赔偿金 82,000 元';

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function request(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/drafts', { headers });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

/** 直接落库，不走 agent 的 insertDraft：这组验的是「读」这一路，写的那一路有它自己的判据 */
function addDraft(caseId: number, kind: string, title: string, content: string, version = 1): void {
  db.prepare(
    `INSERT INTO drafts (case_id, kind, title, content, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
  ).run(caseId, kind, title, content, version);
}

async function body(auth: string, id: number | string) {
  const res = await getDrafts(request(auth), ctx(id));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-casedrafts-${crypto.randomUUID()}.db`);

  getDrafts = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['drafts', 'api_keys', 'cases', 'users']) db.prepare(`DELETE FROM ${t}`).run();

  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);

  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, district, created_at) VALUES (?, ?, '已收通知', '朝阳', '2026-08-19T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(userA, '甲的案子').lastInsertRowid);
  caseB = Number(insertCase.run(userB, '乙的案子').lastInsertRowid);

  addDraft(caseA, '仲裁申请书', A_TITLE, A_BODY);
  addDraft(caseB, '异议函', '《解除劳动合同通知书》异议函', '本人不认可解除理由……', 2);
  addDraft(caseB, '证据清单', '证据清单（第一批）', '一、劳动合同一份……');
});

describe('端点存在，且鉴权照红线走', () => {
  /** 这一条本身就是"端点存在"的判据：上面的动态 import 是它的前半句。 */
  test('路由文件导出了 GET handler', () => {
    expect(typeof getDrafts).toBe('function');
  });

  test('无凭据 401——文书正文不对匿名请求开半个字', async () => {
    const res = await getDrafts(request(), ctx(caseB));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('异议函');
  });

  test('凭据缺 case:read 时不放行', async () => {
    const res = await getDrafts(request(issueKey(userB, ['case:write'])), ctx(caseB));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBe(false);
  });

  test('非数字 id（含 demo）当作不存在——演示案件不走这条端点', async () => {
    expect((await getDrafts(request(signToken(userB)), ctx('demo'))).status).toBe(404);
  });
});

describe('归属：别人的案件当作不存在，且一个字都不漏', () => {
  /**
   * 【这一条是整组的由头】变异臂：把路由交给 lib 的 userId 从 `guard.identity.uid`
   * 换成任何一个写死的值，或者把 lib 里那道 assertOwned 去掉，这条都会红——
   * 而且它红的方式正是最怕的那种：另一个人的仲裁申请书正文被原样返回。
   */
  test('乙拿甲的 case_id 来读 ⇒ 404，且响应里没有甲那份文书的任何一个字', async () => {
    const { status, json } = await body(signToken(userB), caseA);
    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, error_code: 'CASE_NOT_FOUND' });
    const payload = JSON.stringify(json);
    expect(payload).not.toContain(A_TITLE);
    expect(payload).not.toContain('恒昇科技');
    expect(payload).not.toContain('82,000');
  });

  test('压根不存在的 case_id 与「别人的」同一个回答，问不出这个号有没有人用', async () => {
    const stranger = await body(signToken(userB), 999_999);
    const others = await body(signToken(userB), caseA);
    expect(stranger.status).toBe(others.status);
    expect(stranger.json).toEqual(others.json);
  });
});

describe('读自己的：读回自己那几份，不多不少', () => {
  /**
   * 【量具自证】下面两条靠「这个账号不是 1 号、这个案子也不是 1 号」才抓得住
   * `userId: 1` / `caseId: 1` 这类写死。fixture 一旦退化成 1 号，判据会**静默失效**，
   * 所以这里把它当成一条判据写下来，而不是靠注释提醒下一个人。
   */
  test('fixture 自证：乙与乙的案子都不是 1 号', () => {
    expect(userB).not.toBe(1);
    expect(caseB).not.toBe(1);
    expect(caseB).not.toBe(caseA);
  });

  /**
   * 变异臂：`{ caseId, userId: 1 }`（把 userId 写死）⇒ assertOwned 判乙的案子不属于 1 号 ⇒ 404，红；
   *        `{ caseId: 1, userId: … }`（忽略路径里的 caseId）⇒ 乙读到的是 1 号案件 ⇒ 404 或甲的文书，红。
   * 上面「乙读甲的案子」那条抓不住这两个形态：那条在变异后照样是 404。
   */
  test('乙读自己的案件 ⇒ 两份都在，新的在前，且不掺甲的一个字', async () => {
    const { status, json } = await body(signToken(userB), caseB);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    const drafts = json.drafts as Array<Record<string, unknown>>;
    expect(drafts.map((d) => d.title)).toEqual([
      '证据清单（第一批）',
      '《解除劳动合同通知书》异议函',
    ]);
    for (const d of drafts) expect(d.case_id).toBe(caseB);
    expect(JSON.stringify(json)).not.toContain(A_TITLE);
    expect(JSON.stringify(json)).not.toContain('恒昇科技');
  });

  /** 正文一并回：文书页打开就要读全文，回一个空壳等于页面上一片白 */
  test('正文、版本号、状态照库里的行原样交出来', async () => {
    const drafts = (await body(signToken(userB), caseB)).json.drafts as Array<
      Record<string, unknown>
    >;
    const objection = drafts.find((d) => d.kind === '异议函')!;
    expect(objection.content).toBe('本人不认可解除理由……');
    expect(objection.version).toBe(2);
    expect(objection.status).toBe('draft');
    expect(objection.updated_at).toBe('2026-08-20T00:00:00.000Z');
  });

  /** 甲那边同样读得到自己的——否则上面的 0 命中可能只是因为端点谁都不给 */
  test('甲读自己的案件 ⇒ 读到甲那一份（正对照）', async () => {
    const drafts = (await body(signToken(userA), caseA)).json.drafts as Array<
      Record<string, unknown>
    >;
    expect(drafts.map((d) => d.title)).toEqual([A_TITLE]);
  });

  /**
   * 「这个案子还没有文书」与「这个案子不是你的」必须是两个回答：
   * 前者 200 + 空数组（页面据此画诚实空态），后者 404。
   * 混成一个，文书页会对自己名下的空案子说「这个案件不存在」。
   */
  test('自己的案子还没有文书 ⇒ 200 + 空数组，不是 404', async () => {
    db.prepare('DELETE FROM drafts WHERE case_id = ?').run(caseB);
    const { status, json } = await body(signToken(userB), caseB);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, drafts: [] });
  });

  /** api key 那一路（自己的 agent 直连）与网页登录态读到同一份 */
  test('api key 带 case:read 时读到的与网页登录态一致', async () => {
    const viaKey = await body(issueKey(userB, ['case:read']), caseB);
    const viaJwt = await body(signToken(userB), caseB);
    expect(viaKey.status).toBe(200);
    expect(viaKey.json).toEqual(viaJwt.json);
  });
});
