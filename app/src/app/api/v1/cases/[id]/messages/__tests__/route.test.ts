// app/src/app/api/v1/cases/[id]/messages/__tests__/route.test.ts
// 历史对话端点的**通线**判据：真库、真迁移、真路由 handler，一处 mock 都没有。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// messages 表一直在写（agent 每一轮都落两行），但**从来没有读出口**：
// listRecentMessages 只喂服务端拼上下文，网页打开时一个字都不取。
// 于是用户关掉页面再回来，聊过的全部内容在屏幕上消失——而它们一条不少地躺在库里。
// 这条端点是那个缺失的读出口，本组是它的第一份判据。
//
// 对话正文里是解除经过、月薪数字、对公司的措辞、录音里的原话——**串号一次就是正文级泄漏**，
// 比文书更直接（文书是写给对方看的，对话是自己讲的）。所以这组从 handler 本体起跑：
//   变异臂：把 ../route.ts 删掉 —— 下面 beforeAll 的 import 当场失败，整组红。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getMessages: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let caseB: number;

/** 甲那条消息的招牌串：乙的响应里出现任何一个字都算串号 */
const A_SAID = '甲在恒昇科技被裁，月薪 41000';

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function request(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/messages', { headers });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

function addThread(caseId: number, mode: string): number {
  return Number(
    db.prepare('INSERT INTO threads (case_id, mode) VALUES (?, ?)').run(caseId, mode).lastInsertRowid,
  );
}

/** 直接落库，不走 agent：这组验的是「读」那一路 */
function addMessage(
  threadId: number,
  role: string,
  content: string | null,
  model: string | null = null,
  tokensJson: string | null = null,
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO messages (thread_id, role, content, model, tokens_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(threadId, role, content, model, tokensJson).lastInsertRowid,
  );
}

async function body(auth: string, id: number | string) {
  const res = await getMessages(request(auth), ctx(id));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const rowsOf = (json: Record<string, unknown>) => json.messages as Array<Record<string, unknown>>;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-casemsgs-${crypto.randomUUID()}.db`);

  getMessages = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['messages', 'threads', 'api_keys', 'cases', 'users']) {
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
  caseA = Number(insertCase.run(userA, '甲的案子').lastInsertRowid);
  caseB = Number(insertCase.run(userB, '乙的案子').lastInsertRowid);

  addMessage(addThread(caseA, '问诊'), 'user', A_SAID);

  const tB = addThread(caseB, '问诊');
  addMessage(tB, 'user', '我上周三被通知解除，公司说是优化。');
  addMessage(
    tB,
    'assistant',
    '先别签任何文件。把《解除劳动合同通知书》拍照留存。',
    'claude-opus-5',
    JSON.stringify({
      model: 'claude-opus-5',
      usage: { prompt: 3120, completion: 420, cachedRead: 0, cachedWrite: 0 },
      servedModel: 'claude-opus-5',
    }),
  );
});

describe('端点存在，且鉴权照红线走', () => {
  /** 这一条本身就是"端点存在"的判据：上面的动态 import 是它的前半句。 */
  test('路由文件导出了 GET handler', () => {
    expect(typeof getMessages).toBe('function');
  });

  test('无凭据 401——对话正文不对匿名请求开半个字', async () => {
    const res = await getMessages(request(), ctx(caseB));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('解除劳动合同通知书');
  });

  test('凭据缺 case:read 时不放行', async () => {
    const res = await getMessages(request(issueKey(userB, ['case:write'])), ctx(caseB));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBe(false);
  });

  test('非数字 id（含 demo）当作不存在——演示案件不走这条端点', async () => {
    expect((await getMessages(request(signToken(userB)), ctx('demo'))).status).toBe(404);
  });
});

describe('归属：别人的案件当作不存在，且一个字都不漏', () => {
  /**
   * 变异臂：路由交给 lib 的 userId 换成任何写死的值、或 lib 里那道 assertOwned 被拿掉，
   * 这条都会红——而且红的方式正是最怕的那种：另一个人讲的被裁经过被原样返回。
   */
  test('乙拿甲的 case_id 来读 ⇒ 404，且响应里没有甲那句话的任何一个字', async () => {
    const { status, json } = await body(signToken(userB), caseA);
    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, error_code: 'CASE_NOT_FOUND' });
    const payload = JSON.stringify(json);
    expect(payload).not.toContain(A_SAID);
    expect(payload).not.toContain('恒昇科技');
    expect(payload).not.toContain('41000');
  });

  test('压根不存在的 case_id 与「别人的」同一个回答，问不出这个号有没有人用', async () => {
    const stranger = await body(signToken(userB), 999_999);
    const others = await body(signToken(userB), caseA);
    expect(stranger.status).toBe(others.status);
    expect(stranger.json).toEqual(others.json);
  });

  /**
   * 【量具自证】上面两条靠「这个账号不是 1 号、这个案子也不是 1 号」才抓得住
   * `userId: 1` / `caseId: 1` 这类写死。fixture 一旦退化成 1 号，判据会静默失效。
   */
  test('fixture 自证：乙与乙的案子都不是 1 号', () => {
    expect(userB).not.toBe(1);
    expect(caseB).not.toBe(1);
    expect(caseB).not.toBe(caseA);
  });
});

describe('读自己的：两条都在，顺序是当时说话的顺序', () => {
  test('乙读自己的案件 ⇒ 两条，正序（先问后答），且不掺甲的一个字', async () => {
    const { status, json } = await body(signToken(userB), caseB);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    const rows = rowsOf(json);
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[0].content).toContain('上周三被通知解除');
    expect(rows[1].content).toContain('先别签任何文件');
    expect(JSON.stringify(json)).not.toContain(A_SAID);
    expect(JSON.stringify(json)).not.toContain('恒昇科技');
  });

  /** 甲那边同样读得到自己的——否则上面的 0 命中可能只是因为端点谁都不给 */
  test('甲读自己的案件 ⇒ 读到甲那一条（正对照）', async () => {
    const rows = rowsOf((await body(signToken(userA), caseA)).json);
    expect(rows.map((m) => m.content)).toEqual([A_SAID]);
  });

  /**
   * 【一个案子会有两条线程】首诊没走完是 '问诊'，走完变 '陪跑'（orchestrator 自己选的），
   * 而用户从头到尾只在同一个输入框里说话。只回其中一条线程的话，
   * **首诊结束的那一刻，用户此前讲的全部经过就从页面上消失了**——正是这次要修的症状本身。
   */
  test('跨线程合流：问诊与陪跑的消息在同一条时间线上，按真实顺序', async () => {
    const tB2 = addThread(caseB, '陪跑');
    addMessage(tB2, 'user', '公司今天给了一份和解协议。');
    addMessage(tB2, 'assistant', '先看清里面的放弃条款。', 'claude-sonnet-5');

    const rows = rowsOf((await body(signToken(userB), caseB)).json);
    expect(rows).toHaveLength(4);
    expect(rows.map((m) => m.content)).toEqual([
      '我上周三被通知解除，公司说是优化。',
      '先别签任何文件。把《解除劳动合同通知书》拍照留存。',
      '公司今天给了一份和解协议。',
      '先看清里面的放弃条款。',
    ]);
  });

  /**
   * 「生成中/失败」占位行（content IS NULL）不许出去。
   * 放出去就是一条空的助手气泡：用户会以为自己被回了一句空话。
   */
  test('content 为 NULL 的占位行不返回', async () => {
    const tB = db.prepare('SELECT id FROM threads WHERE case_id = ? LIMIT 1').get(caseB) as {
      id: number;
    };
    addMessage(tB.id, 'assistant', null, 'claude-opus-5');

    const rows = rowsOf((await body(signToken(userB), caseB)).json);
    expect(rows).toHaveLength(2);
    for (const m of rows) expect(m.content).toBeTruthy();
  });

  /**
   * 「这个案子还没聊过」与「这个案子不是你的」必须是两个回答：
   * 前者 200 + 空数组（页面据此照常出输入框），后者 404。
   */
  test('自己的案子还没聊过 ⇒ 200 + 空数组，不是 404', async () => {
    db.prepare('DELETE FROM messages').run();
    const { status, json } = await body(signToken(userB), caseB);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, messages: [] });
  });

  /** api key 那一路（自己的 agent 直连）与网页登录态读到同一份 */
  test('api key 带 case:read 时读到的与网页登录态一致', async () => {
    const viaKey = await body(issueKey(userB, ['case:read']), caseB);
    const viaJwt = await body(signToken(userB), caseB);
    expect(viaKey.status).toBe(200);
    expect(viaKey.json).toEqual(viaJwt.json);
  });

  /** 最多回 200 条：别让一个聊了半年的案子把首屏拖成几 MB */
  test('超过 200 条时只回最近的 200 条，且保持正序', async () => {
    db.prepare('DELETE FROM messages').run();
    const tB = addThread(caseB, '陪跑');
    for (let i = 1; i <= 205; i += 1) addMessage(tB, i % 2 ? 'user' : 'assistant', `第 ${i} 句`);

    const rows = rowsOf((await body(signToken(userB), caseB)).json);
    expect(rows).toHaveLength(200);
    expect(rows[0].content).toBe('第 6 句');
    expect(rows[199].content).toBe('第 205 句');
  });
});

describe('每条回答带得出「实际是谁答的」', () => {
  /**
   * 【变异臂：读 requested 而不是 served ⇒ 这条红】
   * 中转按渠道分组路由，请求 opus 完全可能由 sonnet 服务（billing/served-model 文件头实测）。
   * 把请求值当成"实际"标给用户，就是拿一个我们自己都知道可能不对的值去回答
   * "这一轮我拿到的是什么"——而用户是按型号付费的。
   */
  test('回显了别的型号 ⇒ served_model 是实际那个，且 served_mismatch 为真', async () => {
    db.prepare('DELETE FROM messages').run();
    const t = addThread(caseB, '陪跑');
    addMessage(
      t,
      'assistant',
      '按 2N 算。',
      'claude-opus-5',
      JSON.stringify({
        model: 'claude-opus-5',
        usage: { prompt: 10, completion: 10, cachedRead: 0, cachedWrite: 0 },
        servedModel: 'claude-sonnet-5',
      }),
    );

    const [row] = rowsOf((await body(signToken(userB), caseB)).json);
    expect(row.model).toBe('claude-opus-5');
    expect(row.served_model).toBe('claude-sonnet-5');
    expect(row.served_mismatch).toBe(true);
  });

  test('回显与请求一致 ⇒ 不算替代（前缀/变体不是换型号）', async () => {
    const [, assistant] = rowsOf((await body(signToken(userB), caseB)).json);
    expect(assistant.served_model).toBe('claude-opus-5');
    expect(assistant.served_mismatch).toBe(false);
  });

  test('没回显过 ⇒ served_model 为 null，也不算替代（未回显是常态，不是告警）', async () => {
    db.prepare('DELETE FROM messages').run();
    const t = addThread(caseB, '陪跑');
    addMessage(t, 'assistant', '没有计量的那一轮。', 'qwen3.7-max', null);

    const [row] = rowsOf((await body(signToken(userB), caseB)).json);
    expect(row.model).toBe('qwen3.7-max');
    expect(row.served_model).toBeNull();
    expect(row.served_mismatch).toBe(false);
  });

  test('tokens_json 是坏 JSON ⇒ 整条消息照常读得出来，只是没有型号', async () => {
    db.prepare('DELETE FROM messages').run();
    const t = addThread(caseB, '陪跑');
    addMessage(t, 'assistant', '正文必须还在。', 'claude-opus-5', '{不是 json');

    const [row] = rowsOf((await body(signToken(userB), caseB)).json);
    expect(row.content).toBe('正文必须还在。');
    expect(row.served_model).toBeNull();
  });

  /** 用户消息没有型号可言，不该凭空长出一个 */
  test('用户消息的 model / served_model 都是 null', async () => {
    const [user] = rowsOf((await body(signToken(userB), caseB)).json);
    expect(user.role).toBe('user');
    expect(user.model).toBeNull();
    expect(user.served_model).toBeNull();
  });
});
