// app/src/lib/agent/__tests__/sse-sink.test.ts
// 【下发口永不抛】——这是 2026-09-02 那次"页面 This page couldn't load"的直接病灶。
//
// 客户端断开后 controller 是关的，`enqueue` 抛 `Invalid state: Controller is already closed`。
// 从心跳的 setInterval 回调里抛出去时**没有任何调用栈接得住**：Node 记 uncaughtException，
// 而 clearInterval 与它同在一个回调里被跳过，于是每 15 秒再抛一次，把 next 进程带走。
// 服务端日志实录：十几条 uncaughtException 之后整站不可用。
//
// 【变异臂】
//  · M-B1 emit 去掉 try/catch          ⇒ 「enqueue 抛也不外传」「心跳不炸进程」红
//  · M-B2 close 去掉判 gone / try      ⇒ 「close 也不抛」红
//  · M-B3 emit 不判 gone（断开后照发）  ⇒ 「断一次就彻底停发」「markGone 之后不再碰 controller」红
import { describe, expect, it } from 'vitest';

import { startHeartbeat } from '../events';
import { createSseSink, type SseController } from '../sse-sink';

const PING = { event: 'ping', data: { waited_seconds: 1 } } as const;
const DELTA = { event: 'delta', data: { text: '好的。' } } as const;

/** 可编排的假 controller：数调用次数，并能在指定次数后开始抛真实那个 TypeError。 */
function fakeController(opts: { throwFromEnqueue?: number; throwOnClose?: boolean } = {}) {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let enqueues = 0;
  let closes = 0;
  const boom = () => new TypeError('Invalid state: Controller is already closed');
  const controller: SseController & { chunks: string[]; enqueues: number; closes: number } = {
    get chunks() {
      return chunks;
    },
    get enqueues() {
      return enqueues;
    },
    get closes() {
      return closes;
    },
    enqueue(chunk) {
      enqueues += 1;
      if (opts.throwFromEnqueue !== undefined && enqueues >= opts.throwFromEnqueue) throw boom();
      chunks.push(decoder.decode(chunk));
    },
    close() {
      closes += 1;
      if (opts.throwOnClose) throw boom();
    },
  };
  return controller;
}

describe('正常连接：照常写 SSE 线格式', () => {
  it('emit 写成 event/data 两行 + 空行，close 关一次', () => {
    const c = fakeController();
    const sink = createSseSink(c);

    sink.emit(DELTA);
    sink.close();

    expect(c.chunks.join('')).toBe('event: delta\ndata: {"text":"好的。"}\n\n');
    expect(c.closes).toBe(1);
    expect(sink.gone).toBe(false);
  });
});

describe('★客户端断开：一次都不许抛出去', () => {
  it('enqueue 抛 ⇒ emit 自己咽下去，并标记连接已断', () => {
    const c = fakeController({ throwFromEnqueue: 1 });
    const sink = createSseSink(c);

    expect(() => sink.emit(DELTA)).not.toThrow();
    expect(sink.gone).toBe(true);
  });

  it('断一次就彻底停发：后面几十帧一次都不再碰 controller', () => {
    const c = fakeController({ throwFromEnqueue: 1 });
    const sink = createSseSink(c);

    for (let i = 0; i < 20; i++) sink.emit(PING);

    // 只有第一次真的试过；再试只是把同一个异常重复吞 20 遍，还会淹掉第一现场的日志
    expect(c.enqueues).toBe(1);
  });

  it('markGone（流被 cancel）之后一帧都不再往里塞', () => {
    const c = fakeController();
    const sink = createSseSink(c);

    sink.markGone();
    sink.emit(DELTA);
    sink.close();

    expect(c.enqueues).toBe(0);
    expect(c.closes, '已经关掉的流不该再 close 一次').toBe(0);
  });

  it('close 也不抛（它在 async start 的 finally 里，抛出去就是 unhandledRejection）', () => {
    const c = fakeController({ throwOnClose: true });
    const sink = createSseSink(c);

    expect(() => sink.close()).not.toThrow();
  });
});

describe('★心跳：这是把进程带走的那条路', () => {
  /**
   * 心跳的 emit 跑在 setInterval 回调里——**没有任何 try 覆盖得到它**。
   * 它一抛就是 uncaughtException，且 clearInterval 被跳过，于是每个周期再抛一次。
   * 所以"下发口不抛"不是锦上添花，它是这条路上唯一的防线。
   */
  it('连接已断的 sink 喂给 startHeartbeat ⇒ 定时器连着跳好几拍也不炸', async () => {
    const c = fakeController({ throwFromEnqueue: 1 });
    const sink = createSseSink(c);
    sink.emit(DELTA); // 先把连接打成断的（与真机同序：断开先于心跳）

    const uncaught: unknown[] = [];
    const onError = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onError);
    const heartbeat = startHeartbeat(sink.emit, { intervalMs: 2 });
    await new Promise((r) => setTimeout(r, 40));
    heartbeat.stop();
    process.off('uncaughtException', onError);

    expect(uncaught, '心跳把异常抛进了事件循环——生产上这会累积成整站不可用').toEqual([]);
  });
});
