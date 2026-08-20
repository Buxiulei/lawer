// app/src/app/api/v1/cases/[id]/chat/__tests__/route.test.ts
// 对话路由的壳 + 整条 SSE 通路。
// 模型经 vi.mock 换成剧本化假 provider——这里要验的是「路由到 SSE 线格式」这一段，
// 不是模型答得好不好（那是 scripts/eval-agent.ts 的活）。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'better-sqlite3';

import { scriptedProvider, type ScriptedRound } from '@/lib/agent/__tests__/fixtures';

/** 本轮要回放的剧本，由每个用例改写 */
let script: ScriptedRound[] = [];

vi.mock('@/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm')>();
  return {
    ...actual,
    getProvider: () => ({ client: scriptedProvider(script), route: { degraded: false } }),
  };
});

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let post: Handler;
let signToken: (uid: number) => string;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

function request(auth?: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/chat', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 把 SSE 响应体读成 [{event, data}] */
async function readSse(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)![1];
      const data = /^data: (.+)$/m.exec(block)![1];
      return { event, data: JSON.parse(data) };
    });
}

const CARD = {
  name: 'action_card',
  args: {
    what: '今晚 22 点前把解除通知转发到个人邮箱',
    how: '打开公司邮箱转发到私人邮箱，并截图留存',
    why: '权限随时可能被停',
    due_at: '2026-08-19T22:00:00+08:00',
  },
};

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-chat-${crypto.randomUUID()}.db`);

  post = (await import('../route')).POST;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['action_items', 'messages', 'threads', 'timeline_events', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES (?, '已实名')");
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '甲的案子', '已收通知')").run(userA).lastInsertRowid);
  script = [{ text: '手抖是正常的。', tools: [CARD] }, { text: '' }];
});

describe('闸门（开流之前就要判完）', () => {
  test('没凭据 401', async () => {
    const res = await post(request(undefined, { message: '你好' }), ctx(caseA));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error_code: 'UNAUTHORIZED' });
  });

  test('别人的案子 404，且用的是与「不存在」同一个错误码', async () => {
    const res = await post(request(signToken(userB), { message: '你好' }), ctx(caseA));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: 'CASE_NOT_FOUND' });
  });

  test('message 为空 400（不能开了流再报错，那时状态码已经定死 200）', async () => {
    const res = await post(request(signToken(userA), { message: '   ' }), ctx(caseA));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: 'EMPTY_MESSAGE' });
  });

  test('mode 是用户可控输入，枚举外的值 400（不能让脏值写进 threads.mode）', async () => {
    const res = await post(request(signToken(userA), { message: '你好', mode: '随便写的模式' }), ctx(caseA));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: 'INVALID_MODE' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 0 });
  });

  test('请求体不是 JSON 400', async () => {
    const req = new Request('http://localhost/api/v1/cases/1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(userA)}` },
      body: '不是 json',
    });
    expect((await post(req, ctx(caseA))).status).toBe(400);
  });
});

describe('SSE 通路', () => {
  test('响应头是 event-stream 且关掉了反代缓冲', async () => {
    const res = await post(request(signToken(userA), { message: '刚收到辞退邮件' }), ctx(caseA));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });

  test('帧序与形状：meta → delta… → action → usage → done', async () => {
    const res = await post(request(signToken(userA), { message: '刚收到辞退邮件' }), ctx(caseA));
    const frames = await readSse(res);
    const kinds = frames.map((f) => f.event);

    expect(kinds[0]).toBe('meta');
    expect(kinds.at(-1)).toBe('done');
    expect(kinds.at(-2)).toBe('usage');
    expect(kinds).toContain('action');

    const text = frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('');
    expect(text).toBe('手抖是正常的。');

    const action = frames.find((f) => f.event === 'action')!;
    expect(action.data).toMatchObject({ title: CARD.args.what, index: 1 });
    expect(frames.find((f) => f.event === 'meta')!.data).toMatchObject({ mode: '问诊', degraded: false });
  });

  test('落库真的发生了（行动卡与消息都在库里）', async () => {
    await readSse(await post(request(signToken(userA), { message: '刚收到辞退邮件' }), ctx(caseA)));
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?').get(caseA)).toEqual({ n: 1 });
    const msgs = db.prepare('SELECT role, content FROM messages ORDER BY id').all() as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('手抖是正常的。');
  });

  test('模型侧异常以 error 帧如实透出，而不是让光标一直转', async () => {
    const boom = {
      name: 'deepseek' as const,
      model: 'x',
      billingModel: 'x',
      chatStream: async () => {
        throw new Error('anthropic(claude-sonnet-5) chatStream 502');
      },
    };
    const llm = await import('@/lib/llm');
    const spy = vi.spyOn(llm, 'getProvider').mockReturnValue({ client: boom, route: { degraded: false } } as never);

    const frames = await readSse(await post(request(signToken(userA), { message: '在吗' }), ctx(caseA)));
    expect(frames.at(-1)).toMatchObject({ event: 'error', data: { code: 'AGENT_FAILED' } });
    expect(String(frames.at(-1)!.data.message)).toContain('502');
    spy.mockRestore();
  });
});
