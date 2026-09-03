// app/src/app/api/v1/cases/[id]/chat/__tests__/route.test.ts
// 对话路由的壳 + 整条 SSE 通路。
// 模型经 vi.mock 换成剧本化假 provider——这里要验的是「路由到 SSE 线格式」这一段，
// 不是模型答得好不好（那是 scripts/eval-agent.ts 的活）。
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'better-sqlite3';

import { scriptedProvider, type ScriptedRound } from '@/lib/agent/__tests__/fixtures';
import type { AgentEventSink } from '@/lib/agent';

/** 本轮要回放的剧本，由每个用例改写 */
let script: ScriptedRound[] = [];

vi.mock('@/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm')>();
  return {
    ...actual,
    getProvider: () => ({ client: scriptedProvider(script), route: { degraded: false } }),
  };
});

/**
 * 路由**实际交给心跳定时器**的那个函数，原样接住。
 *
 * 【为什么要接它】事故现场就是这个位置：心跳在 `setInterval` 回调里调它，
 * 而定时器回调没有任何调用栈接得住异常——Node 直接记 uncaughtException，
 * 且 `clearInterval` 与它同在那个回调里会被跳过，于是每个周期再抛一次，
 * 直到把整个 next 进程带走。所以「心跳拿到的是不是那个永不抛的 sink.emit」
 * 是一条要钉住的产线事实，而不是路由内部的实现细节。
 */
const heartbeatWiring = vi.hoisted(() => ({ emit: null as AgentEventSink | null }));

vi.mock('@/lib/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent')>();
  return {
    ...actual,
    startHeartbeat: (emit: AgentEventSink, opts?: { intervalMs?: number; now?: () => number }) => {
      heartbeatWiring.emit = emit;
      return actual.startHeartbeat(emit, opts);
    },
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

/** 把 SSE 线格式解析成 [{event, data}] */
function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)![1];
      const data = /^data: (.+)$/m.exec(block)![1];
      return { event, data: JSON.parse(data) };
    });
}

/** 把 SSE 响应体读成 [{event, data}] */
async function readSse(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  return parseSse(await res.text());
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
  // 记账接线后，一轮对话也会在 token_usage / gongdao_ledger / gongdao 留行，
  // 它们都外键指向 users——清 users 之前必须先清它们（子表先于父表）。
  for (const t of [
    'action_items', 'messages', 'threads', 'timeline_events', 'cases',
    'token_usage', 'gongdao_ledger', 'gongdao', 'users',
  ]) {
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

  test('模型侧异常必有 error 帧收尾，而不是让光标一直转', async () => {
    const spy = await stubProviderThrowing('anthropic(claude-sonnet-5) chatStream 502');

    const frames = await readSse(await post(request(signToken(userA), { message: '在吗' }), ctx(caseA)));
    expect(frames.at(-1)).toMatchObject({ event: 'error', data: { code: 'AGENT_FAILED' } });
    spy.mockRestore();
  });

  /**
   * 【失败要挺过一次刷新】(naive-qa-2 F-203) 此前失败只是一张前端的卡：刷新后
   * 屏幕上只剩用户自己那句问题干晾着。现在这一轮落成一条 failed_code 行，
   * 且 error 帧带回它的 id——前端点「重试」时靠它说出重试的是哪一轮。
   *
   * 变异臂：runTurn 外壳的 catch 改回直接 rethrow ⇒ 这条红。
   */
  test('★模型失败 ⇒ 库里落一条失败的 assistant 行，error 帧带回它的 id，且不记账', async () => {
    const spy = await stubProviderThrowing('anthropic(claude-sonnet-5) chatStream 502');
    const frames = await readSse(await post(request(signToken(userA), { message: '在吗' }), ctx(caseA)));
    spy.mockRestore();

    const rows = db
      .prepare('SELECT id, role, content, failed_code FROM messages ORDER BY id')
      .all() as { id: number; role: string; content: string | null; failed_code: string | null }[];
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1].failed_code).toBe('AGENT_FAILED');
    expect(rows[1].content, 'content 停在 NULL = 刷新后这一轮整个消失').not.toBeNull();

    const err = frames.at(-1)!;
    expect(err.event).toBe('error');
    // toFrame 那一层把数字主键转成串，这里断言的是服务端发出去的原值（number）
    expect(err.data.message_id).toBe(rows[1].id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type = '消耗'").get()).toEqual({ n: 0 });
  });

  /** 变异臂：路由不透传 retryOf（或编排层照插用户行）⇒ 这条红 */
  test('★retry_of 重试 ⇒ 新增一条回答，用户消息不重复', async () => {
    const spy = await stubProviderThrowing('anthropic(claude-sonnet-5) chatStream 502');
    await readSse(await post(request(signToken(userA), { message: '在吗' }), ctx(caseA)));
    spy.mockRestore();

    const failed = db
      .prepare("SELECT id FROM messages WHERE failed_code IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { id: number };

    script = [{ text: '在的。先别签任何文件。' }];
    const frames = await readSse(
      await post(request(signToken(userA), { retry_of: failed.id }), ctx(caseA)),
    );
    expect(frames.at(-1)!.event).toBe('done');

    const rows = db.prepare('SELECT role, content, failed_code FROM messages ORDER BY id').all() as {
      role: string;
      content: string | null;
      failed_code: string | null;
    }[];
    expect(rows.filter((r) => r.role === 'user'), '重试插了第二句一模一样的问话').toHaveLength(1);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(rows[2].failed_code).toBeNull();
    expect(rows[2].content).toContain('先别签');
  });

  test('retry_of 不是消息 id（负数 / 小数 / 乱串）⇒ 400，不开流', async () => {
    for (const bad of [-1, 0, 1.5, 'abc']) {
      const res = await post(request(signToken(userA), { retry_of: bad }), ctx(caseA));
      expect(res.status, `retry_of=${bad}`).toBe(400);
      expect((await res.json()).error_code).toBe('INVALID_RETRY_OF');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 0 });
  });

  // 这一帧会渲染成当事人屏幕上的报错卡。llm/router 缺 key 时的 message 是写给运维看的
  // （环境变量名 + 要改哪个文件），当事人既看不懂也做不了——原文进服务端日志，出去的是三段式。
  test('内部异常原文不过边界：error 帧只带稳定错误码 + 三段式文案，原文只在服务端日志里', async () => {
    const RAW =
      'entry/standard 无可用模型：降级链上的 key 全部缺失（DEEPSEEK_API_KEY(deepseek-chat) → ' +
      'DASHSCOPE_API_KEY(qwen-max)），请补齐 app/.env.local';
    const spy = await stubProviderThrowing(RAW);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });

    const raw = await (await post(request(signToken(userA), { message: '在吗' }), ctx(caseA))).text();

    // ① 敏感串一个都不许过边界
    expect(raw).not.toContain('DEEPSEEK_API_KEY');
    expect(raw).not.toContain('DASHSCOPE_API_KEY');
    expect(raw).not.toContain('.env.local');
    expect(raw).not.toContain(RAW);

    // ② 用户拿到的是三段式：出了什么事 / 为什么 / 怎么办
    const err = parseSse(raw).at(-1)!;
    expect(err.event).toBe('error');
    expect(err.data.code).toBe('AGENT_FAILED'); // 错误码保留给前端做分支
    const message = String(err.data.message);
    expect(message).toContain('没能生成回答');
    expect(message).toContain('模型服务这会儿连不上');
    expect(message).toContain('重试');

    // ③ 原文完整留在服务端日志（换壳不是消音）
    const log = logs.join('\n');
    expect(log).toContain('DEEPSEEK_API_KEY');
    // 定位串是 `agent.runTurn` 而不是 `chat.runTurn`：F-203 之后这次换壳发生在编排层的
    // 失败分支里（它同时要把这一轮标成失败落库），不再是路由 catch 里那一处。
    // 路由那一层的 catch 仍在，接的是 emit / 心跳这类**流之外**抛出来的东西。
    expect(log).toContain('agent.runTurn');
    expect(log).toContain('AGENT_FAILED');

    logSpy.mockRestore();
    spy.mockRestore();
  });
});

/* ── 客户端中途走人 ────────────────────────────────────────────
   真机事故（2026-09-02）：用户读完回答后刷新/关页，SSE 的 controller 随之关闭，
   之后每一次 enqueue 抛 `Invalid state: Controller is already closed`。它有两条路，
   两条都致命：从 runTurn 的 emit 抛出去 → 正文不落库、这一轮不记账；
   从**心跳的 setInterval 回调**抛出去 → 没有调用栈接得住，Node 记 uncaughtException，
   且 clearInterval 被跳过，于是每个心跳周期再抛一次，直到把 next 进程带走。
   这一组钉的是：断开只影响下发，不影响这一轮跑完。 */
describe('客户端断开', () => {
  test('读到一半就走人 ⇒ 这一轮照样落库记账，且不抛未捕获异常', async () => {
    const gated = await stubProviderGated();

    const res = await post(request(signToken(userA), { message: '刚收到辞退邮件' }), ctx(caseA));
    const reader = res.body!.getReader();
    // 先收一帧（meta），确认流真的开起来了；再断开——这就是"回答渲染完随手 F5"
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: meta');
    await reader.cancel();

    // 客户端走了，模型这才把这一轮跑完：正文 → 工具 → 收尾
    gated.release();

    await vi.waitFor(() => {
      const row = db.prepare("SELECT content FROM messages WHERE role = 'assistant'").get() as
        | { content: string | null }
        | undefined;
      expect(row?.content, '正文停在 NULL = 刷新之后那一轮永久消失').toBe('手抖是正常的。');
    }, { timeout: 5000 });

    expect(db.prepare('SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?').get(caseA)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type = '消耗'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get()).toEqual({ n: 1 });

    gated.restore();
  });

  /**
   * ★这一条钉的是**接线**，不是 sse-sink 自己的行为。
   *
   * 复审 2026-09-02（RV-V）指出：把 `const emit = out.emit` 换回一整套裸
   * `controller.enqueue` 闭包，现有判据全部无感——而心跳正是那条**不经过任何一层 try**
   * 的通路（sse-sink.ts 文件头的第 ② 条）。所以直接问路由：
   * 你交给 `setInterval` 的到底是哪个函数？客户端走了之后它抛不抛？
   *
   * 变异臂 M-H1：route.ts 换回裸 controller.enqueue ⇒ 这一条红。
   */
  test('★心跳拿到的是永不抛的 sink.emit：客户端走人之后 tick 静默，不抛', async () => {
    const gated = await stubProviderGated();
    heartbeatWiring.emit = null;

    const res = await post(request(signToken(userA), { message: '刚收到辞退邮件' }), ctx(caseA));
    const reader = res.body!.getReader();
    await reader.read(); // 先收一帧，确认流真的开起来了
    // 显式标注：上面那句 `= null` 会让 TS 把这个属性一路窄成 null，`tick!` 就成了 never
    const tick: AgentEventSink | null = heartbeatWiring.emit;
    expect(tick, '路由根本没把心跳接上（接线断了，这条判据会变成空跑）').toBeTypeOf('function');

    // 客户端走人：controller 随之关闭，此后 enqueue 一律抛 Invalid state（实测同形）
    await reader.cancel();

    // 心跳周期到点时，setInterval 回调就是拿这个函数发 ping 的
    expect(() => tick!({ event: 'ping', data: { waited_seconds: 15 } })).not.toThrow();
    // 第二个周期同样不抛——"断一次就彻底停发"，不是"第一次吞掉、后面继续抛"
    expect(() => tick!({ event: 'ping', data: { waited_seconds: 30 } })).not.toThrow();

    // 顺带：这一轮照样跑完（下发断了不影响落库），免得留一个悬挂的 runTurn
    gated.release();
    await vi.waitFor(() => {
      const row = db.prepare("SELECT content FROM messages WHERE role = 'assistant'").get() as
        | { content: string | null }
        | undefined;
      expect(row?.content).toBe('手抖是正常的。');
    }, { timeout: 5000 });

    gated.restore();
  });
});

/* ── 接线的结构守卫 ──────────────────────────────────────────────
   行为判据（上面那条）钉住"心跳拿到的函数不抛"；这一组钉住**为什么不抛**——
   路由里根本不该再有第二个下发口。两条一起，RV-V 那种"换回裸 enqueue 全套"
   才不会有一条缝隙可钻。 */
describe('心跳与断开的接线（结构守卫）', () => {
  const SRC = readFileSync(new URL('../route.ts', import.meta.url), 'utf8');

  test('路由里没有第二个下发口：裸 controller.enqueue / controller.close 一处都不许有', () => {
    expect(SRC, '判可写只能做在唯一的出口上（sse-sink.ts 文件头）').not.toMatch(/controller\.enqueue/);
    expect(SRC, 'close 抛在 async start 的 finally 里就是 unhandledRejection').not.toMatch(/controller\.close/);
  });

  test('心跳接的是 sink 的 emit', () => {
    expect(SRC).toMatch(/const\s+out\s*=\s*createSseSink\(controller\)/);
    expect(SRC).toMatch(/const\s+emit\s*=\s*out\.emit/);
    expect(SRC).toMatch(/startHeartbeat\(\s*emit\s*[,)]/);
  });

  test('cancel 回调把 sink 标记为已断（客户端断开的第一手信号，不必等第一次 enqueue 抛）', () => {
    expect(SRC).toMatch(/cancel\(\)\s*\{[^}]*markGone\(\)/);
  });
});

/**
 * 门控假 provider：第一次 chatStream 停在闸口，等测试放行才吐字。
 * 剧本与默认那份等价（正文 + 一张行动卡 + 收尾轮），只是多了个可控的停顿点，
 * 好让"客户端断开"精确地落在**这一轮还没跑完**的时候——否则这条用例会变成空跑。
 */
async function stubProviderGated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let round = 0;
  const client = {
    name: 'deepseek' as const,
    model: 'deepseek-v4-pro',
    billingModel: 'DeepSeek-V4-Pro-0813',
    async chatStream() {
      const mine = round++;
      return (async function* () {
        if (mine === 0) await gate;
        for (const ch of mine === 0 ? '手抖是正常的。' : '') yield ch;
        return {
          finishReason: mine === 0 ? 'tool_calls' : 'stop',
          toolCalls:
            mine === 0
              ? [{ id: 'call_1', type: 'function' as const, function: { name: CARD.name, arguments: JSON.stringify(CARD.args) } }]
              : [],
          usage: {
            model: 'DeepSeek-V4-Pro-0813',
            usage: { prompt: 100, completion: 20, cachedRead: 0, cachedWrite: 0 },
            servedModel: 'deepseek-v4-pro',
          },
        };
      })();
    },
  };
  const llm = await import('@/lib/llm');
  const spy = vi.spyOn(llm, 'getProvider').mockReturnValue({ client, route: { degraded: false } } as never);
  return { release, restore: () => spy.mockRestore() };
}

/** 把 provider 换成"一调用就抛"的假货，抛出指定 message */
async function stubProviderThrowing(message: string) {
  const boom = {
    name: 'deepseek' as const,
    model: 'x',
    billingModel: 'x',
    chatStream: async () => {
      throw new Error(message);
    },
  };
  const llm = await import('@/lib/llm');
  return vi
    .spyOn(llm, 'getProvider')
    .mockReturnValue({ client: boom, route: { degraded: false } } as never);
}
