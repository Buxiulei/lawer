// app/src/lib/llm/__tests__/gate.test.ts
// 上游调用闸（providers/gate.ts）：并发信号量 + 连接期重试。
// 这里守的是两条会直接烧钱/伤用户的边界：
//   ① 流已经开始出字之后**绝不**重试（重试 = 重复计费 + 用户看到重复正文）；
//   ② 闸满时排队而不是把 33 路一起打上去，排不到就给 503 而不是无限等。
// 计时用假定时器：真等 30s 排队 / 4s 退避会把整个套件拖垮。
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createAnthropic } from '../providers/anthropic';
import { createDeepSeek } from '../providers/deepseek';
import {
  LlmGateBusyError,
  MAX_CONCURRENT_PER_PROVIDER,
  QUEUE_WAIT_MS,
  acquireSlot,
  connectWithRetry,
} from '../providers/gate';
import { drain, sseResponse } from './mock-fetch';

const dataLine = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const textDelta = (s: string) => dataLine({ choices: [{ index: 0, delta: { content: s } }] });
const OK_SSE = textDelta('好的') + 'data: [DONE]\n\n';

/** Anthropic 侧的一条最小完整流（事件语义与兼容层完全不同，故单列） */
const anthEv = (o: { type: string } & Record<string, unknown>) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const ANTHROPIC_OK_SSE =
  anthEv({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) +
  anthEv({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  anthEv({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } }) +
  anthEv({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
  anthEv({ type: 'message_stop' });

/** 排队用例专用：把闸占到 count 路（缺省占满），返回一组释放函数
 *  （用例结束必须全放，否则污染同 provider 的后续用例）。 */
async function fillGate(
  provider: 'openai' | 'anthropic' | 'dashscope' | 'deepseek',
  count = MAX_CONCURRENT_PER_PROVIDER,
) {
  const held: (() => void)[] = [];
  for (let i = 0; i < count; i++) held.push(await acquireSlot(provider));
  return () => held.forEach((r) => r());
}

/** 让排队中的 acquireSlot 有机会 resolve：闸没满时它只隔一跳微任务。 */
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** 一条「出了一段字就再也不动」的流：用来制造被抛弃的 generator（读不到 done，也不报错）。 */
function hangingSseResponse(firstChunk: string): Response {
  const enc = new TextEncoder();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(enc.encode(firstChunk));
      // 之后不 enqueue 也不 close：上游还连着，只是不再出字
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 一条握手成功、开读即炸的流（客户端/中间层断连的形态） */
function brokenSseResponse(err: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(err);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('连接期重试（首字节之前）', () => {
  test('429 → 重试后成功，用户拿到正常正文，只是慢了一次退避', async () => {
    vi.useFakeTimers();
    const statuses: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      statuses.push(n);
      if (n === 1) return new Response('{"error":"rate limited"}', { status: 429 });
      return sseResponse(OK_SSE);
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const pending = p.chatStream([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(1_000); // 第一次退避 1s
    const { text } = await drain(await pending);

    expect(n).toBe(2); // 打了两次：429 一次 + 成功一次
    expect(text).toBe('好的');
  });

  test('502 / 503 / 网络错都重试，且最多两次（总共三次请求）', async () => {
    for (const failure of [
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('unavailable', { status: 503 }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      vi.useFakeTimers();
      let n = 0;
      const fetchImpl = (async () => {
        n++;
        return failure();
      }) as unknown as typeof fetch;
      const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

      const pending = p.chatStream([{ role: 'user', content: 'x' }]).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1_000 + 4_000);
      const err = await pending;

      expect(n).toBe(3); // 1 次原始 + 2 次重试，不再多打
      expect(err).toBeInstanceOf(Error);
      vi.useRealTimers();
    }
  });

  test('429 的 Retry-After（秒数）优先于固定退避', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
      return sseResponse(OK_SSE);
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const pending = p.chatStream([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(1_000); // 固定退避的 1s 到了
    expect(n).toBe(1); // 但 Retry-After 说等 3s，所以还没重发
    await vi.advanceTimersByTimeAsync(2_000);
    const { text } = await drain(await pending);
    expect(n).toBe(2);
    expect(text).toBe('好的');
  });

  test('Retry-After 只有空白字符（NBSP）→ 按「没给」处理走缺省退避，不是零退避立刻重发', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      // 空格/制表会被 Headers 规范化成空串，NBSP 不会——所以这是真能进到解析器里的「空白头」
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '\u00a0' } });
      return sseResponse(OK_SSE);
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const pending = p.chatStream([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(999);
    // Number('\u00a0'.trim()) 是 0：当秒数读的话退避就是 0，这一刻早已重发——正好在被限流时给上游加压
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(2); // 跨过缺省退避的 1s
    const { text } = await drain(await pending);
    expect(n).toBe(2);
    expect(text).toBe('好的');
  });

  test('Retry-After 长到超出等待意义（>10s）→ 不干等，直接把 429 抛出去', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('come back later', { status: 429, headers: { 'retry-after': '600' } });
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    await expect(p.chatStream([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 429[\s\S]*come back later/);
    expect(n).toBe(1);
  });

  test('不可重试的状态（402 余额不足）一次就抛，不浪费闸位重试', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('{"error":{"message":"insufficient balance"}}', { status: 402 });
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    await expect(p.chatStream([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 402/);
    expect(n).toBe(1);
  });

  test('中止（超时/取消）不是「上游不给力」，不重试', async () => {
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    const attempt = async () => {
      n++;
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    await expect(connectWithRetry(attempt, ac.signal)).rejects.toThrow('aborted');
    expect(n).toBe(1);
  });

  test('退避期间被中止 → 立刻停手，不等满退避也不再重发', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    let n = 0;
    const attempt = async () => {
      n++;
      if (ac.signal.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      throw new TypeError('fetch failed');
    };
    const pending = connectWithRetry(attempt, ac.signal).catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    ac.abort(); // 空闲/总时长超时在退避中途打进来
    const err = await pending;

    expect((err as Error).name).toBe('AbortError');
    expect(n).toBe(2); // 只多了那次「被中止的信号让 fetch 立刻拒绝」，没有真的重发第三次
  });
});

describe('流开始之后绝不重试', () => {
  test('首字节已到再断流 → 错误原样上抛，且不重发请求（不重复计费、不重复正文）', async () => {
    let n = 0;
    const boom = new Error('socket hang up');
    const fetchImpl = (async () => {
      n++;
      // 先给出真实的一段正文，再让流炸掉——这正是「已经开始出字」的形态。
      // 必须分两次 pull：controller.error() 会清空已入队的分片，写在同一个 start 里首字节就到不了用户手上。
      const enc = new TextEncoder();
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(enc.encode(textDelta('已经开始')));
          else controller.error(boom);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const gen = await p.chatStream([{ role: 'user', content: 'x' }]);
    const first = await gen.next();
    expect(first.value).toBe('已经开始'); // 首字节确实到了用户手上

    await expect(gen.next()).rejects.toThrow('socket hang up');
    expect(n).toBe(1); // 只打过一次上游
  });

  test('断流之后闸位归还（不然连断几次就把闸漏干）', async () => {
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('boom'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    for (let i = 0; i < MAX_CONCURRENT_PER_PROVIDER + 5; i++) {
      const gen = await p.chatStream([{ role: 'user', content: 'x' }]);
      await expect(gen.next()).rejects.toThrow('boom');
    }
    // 闸真漏了的话，这里第 33 次就会挂住 30s（假定时器下则永远挂住）
    const release = await acquireSlot('deepseek');
    release();
  });

  test('generator 被抛弃（消费方 emit 抛错后既不 next() 也不 return()）→ 超时兜底归还闸位', async () => {
    vi.useFakeTimers();
    // 上游还连着、只是不再出字：这一路的 sseData 停在 read() 上，它的 finally 永远等不到。
    const fetchImpl = (async () => hangingSseResponse(textDelta('已经开始'))) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const drainGate = await fillGate('deepseek', MAX_CONCURRENT_PER_PROVIDER - 1);
    const gen = await p.chatStream([{ role: 'user', content: 'x' }], { idleTimeoutMs: 1_000 });
    expect((await gen.next()).value).toBe('已经开始'); // 已经开始消费
    // …然后就此撒手：既不再 next()，也不 return()。gen 被抛弃，onDone 这条路彻底断了。

    let granted = false;
    const queued = acquireSlot('deepseek').then((r) => {
      granted = true;
      return r;
    });
    await flushMicrotasks();
    expect(granted).toBe(false); // 被抛弃的那一路确实还占着最后一个闸位

    await vi.advanceTimersByTimeAsync(1_100); // 空闲超时打进来 → abort → 兜底 release
    const release = await queued;
    expect(granted).toBe(true); // 闸位归还了；没有这条兜底，这一位就是永久漏的

    release();
    drainGate();
  });
});

// M1 变异（anthropic.ts 整文件退回加闸前）要在这里转红：以下每条都只能由 anthropic 侧真的接了闸才成立。
describe('anthropic 走同一道闸', () => {
  const anthropic = (fetchImpl: typeof fetch) => createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });

  test('429 → 连接期重试后成功，用户拿到正常正文', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response('{"type":"error"}', { status: 429 });
      return sseResponse(ANTHROPIC_OK_SSE);
    }) as unknown as typeof fetch;

    const pending = anthropic(fetchImpl).chatStream([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(1_000); // 第一次退避 1s
    const { text } = await drain(await pending);

    expect(n).toBe(2); // 没有闸的话第一次 429 就直接抛给用户了
    expect(text).toBe('好的');
  });

  test(`闸满且排队超过 ${QUEUE_WAIT_MS / 1000}s → LlmGateBusyError(503)，且压根没打上游`, async () => {
    vi.useFakeTimers();
    const drainGate = await fillGate('anthropic');
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }) as unknown as typeof fetch;

    const pending = anthropic(fetchImpl).chatStream([{ role: 'user', content: 'x' }]).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1);
    const err = await pending;

    expect(err).toBeInstanceOf(LlmGateBusyError);
    expect((err as LlmGateBusyError).status).toBe(503);
    expect(n).toBe(0); // 关键：闸满时排队等，而不是把第 33 路裸打到上游

    drainGate();
  });

  test('断流 → 闸位归还（且断流之前确实占着一个闸位）', async () => {
    const fetchImpl = (async () => brokenSseResponse(new Error('boom'))) as unknown as typeof fetch;
    const drainGate = await fillGate('anthropic', MAX_CONCURRENT_PER_PROVIDER - 1);
    const gen = await anthropic(fetchImpl).chatStream([{ role: 'user', content: 'x' }]);

    let granted = false;
    const queued = acquireSlot('anthropic').then((r) => {
      granted = true;
      return r;
    });
    await flushMicrotasks();
    expect(granted).toBe(false); // anthropic 这一路占住了最后一个闸位（没接闸的话这里立刻就拿到了）

    await expect(gen.next()).rejects.toThrow('boom');
    const release = await queued;
    expect(granted).toBe(true); // 断流把闸位还了，排队者立刻顶上

    release();
    drainGate();
  });

  test('generator 被抛弃 → 超时兜底归还闸位', async () => {
    vi.useFakeTimers();
    const firstDelta = anthEv({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已经开始' } });
    const fetchImpl = (async () => hangingSseResponse(firstDelta)) as unknown as typeof fetch;

    const drainGate = await fillGate('anthropic', MAX_CONCURRENT_PER_PROVIDER - 1);
    const gen = await anthropic(fetchImpl).chatStream([{ role: 'user', content: 'x' }], { idleTimeoutMs: 1_000 });
    expect((await gen.next()).value).toBe('已经开始');
    // 就此撒手：不再 next()，也不 return()

    let granted = false;
    const queued = acquireSlot('anthropic').then((r) => {
      granted = true;
      return r;
    });
    await flushMicrotasks();
    expect(granted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_100);
    const release = await queued;
    expect(granted).toBe(true);

    release();
    drainGate();
  });
});

describe('排队 FIFO', () => {
  test('先排的先走：后来者不会插队，早到的不会被饿死', async () => {
    const drainGate = await fillGate('openai');
    const order: string[] = [];
    const first = acquireSlot('openai').then((r) => {
      order.push('first');
      return r;
    });
    const second = acquireSlot('openai').then((r) => {
      order.push('second');
      return r;
    });
    await flushMicrotasks();
    expect(order).toEqual([]); // 两路都在排队

    drainGate(); // 32 个闸位一次性放开
    const releases = [await first, await second];
    expect(order).toEqual(['first', 'second']);
    releases.forEach((r) => r());
  });
});

describe('并发闸', () => {
  test('闸满时第 33 路等待，前面一放行就立刻拿到位', async () => {
    const drainGate = await fillGate('openai');
    let granted = false;
    const pending = acquireSlot('openai').then((r) => {
      granted = true;
      return r;
    });

    await Promise.resolve();
    expect(granted).toBe(false); // 第 33 路确实在排队，没有裸打上去

    drainGate(); // 前面的都放了
    const release = await pending;
    expect(granted).toBe(true);
    release();
  });

  test(`排队超过 ${QUEUE_WAIT_MS / 1000}s → 503 自述错误，而不是无限等`, async () => {
    vi.useFakeTimers();
    const drainGate = await fillGate('dashscope');
    const pending = acquireSlot('dashscope').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_MS - 1);
    // 差 1ms 还在等——闸没有提前放弃
    expect(await Promise.race([pending, Promise.resolve('still-waiting')])).toBe('still-waiting');

    await vi.advanceTimersByTimeAsync(2);
    const err = await pending;
    expect(err).toBeInstanceOf(LlmGateBusyError);
    const e = err as LlmGateBusyError;
    expect(e.status).toBe(503);
    expect(e.errorCode).toBe('LLM_BUSY');
    expect(e.userMessage).toContain('当前咨询人数较多');
    // 三段式自述：缺什么 / 为什么 / 怎么办
    expect(e.message).toContain('缺：');
    expect(e.message).toContain('原因：');
    expect(e.message).toContain('怎么办：');
    expect(e.message).toContain('dashscope');

    drainGate();
  });

  test('闸位按 provider 分桶：deepseek 排满不挡 openai', async () => {
    const drainGate = await fillGate('deepseek');
    const release = await acquireSlot('openai'); // 立刻拿到，不排队
    release();
    drainGate();
  });

  test('排队超时后的等待者被摘出队列，不会白占后来释放的闸位', async () => {
    vi.useFakeTimers();
    const drainGate = await fillGate('anthropic');
    const timedOut = acquireSlot('anthropic').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1);
    expect(await timedOut).toBeInstanceOf(LlmGateBusyError);

    drainGate(); // 全放开；若超时者还赖在队里，会吞掉一个位子
    vi.useRealTimers();
    const release = await acquireSlot('anthropic');
    release();
  });

  test('正常一次成功的调用不排队、不重试，happy path 不受闸影响', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return sseResponse(OK_SSE);
    }) as unknown as typeof fetch;
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const { text, result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(n).toBe(1);
    expect(text).toBe('好的');
    expect(result.finishReason).toBeNull();
    // 流读完 → 闸位已归还
    const release = await acquireSlot('deepseek');
    release();
  });
});
