// app/src/lib/agent/sse-sink.ts
// SSE 下发口：把事件帧写进 ReadableStream 的 controller，且**一次都不抛**。
//
// 【为什么这是一个有名字的东西，而不是路由里的一行闭包】(2026-09-02 真机事故)
// 客户端断开（刷新 / 关页 / 断网）之后 controller 就是关的，此后每一次 `enqueue` 都抛
// `TypeError: Invalid state: Controller is already closed`。这个异常有**两条**去路，
// 两条都致命，而实测两条都发生了：
//
//  ① 从 `runTurn` 的 emit 里抛出去 → 掀翻 tool-loop 与收尾：
//     时间线写了、行动卡没写，正文停在 NULL（刷新即永久消失），这一轮不记账。
//  ② 从**心跳的 `setInterval` 回调**里抛出去 → 定时器回调没有调用栈接得住它，
//     Node 直接记 `uncaughtException`；而 `clearInterval` 与它在同一个回调里，
//     被跳过，于是每隔一个心跳周期再抛一次，直到把整个 next 进程带走
//     （服务端日志实录：连续十几条 uncaughtException 之后页面变成 "This page couldn't load"）。
//
// 第 ② 条是关键：**它不经过任何一层 try**，所以"每个调用点自己小心"这条路根本走不通——
// 判可写这件事只能做在**唯一的出口**上。于是有了这个文件。
//
// 【它不负责什么】它只保证"下发失败不会变成异常"。至于失败之后这一轮要不要继续跑完、
// 要不要落库记账，那是 orchestrator 的事（答案是：要，模型的钱已经花掉了）。
import { encodeSse, type AgentEvent } from './events';

/** 只用到 controller 的这两件事；收窄成结构类型是为了测试能塞一个会抛的假 controller 进来。 */
export interface SseController {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
}

export interface SseSink {
  /** 下发一帧。连接没了就静默丢弃——**永不抛**。 */
  emit: (e: AgentEvent) => void;
  /** 客户端已经不在了（enqueue 失败过，或流被 cancel）。true 之后一帧都不再发。 */
  readonly gone: boolean;
  /** 客户端主动断开的第一手信号（ReadableStream 的 cancel 回调）：不必等第一次 enqueue 抛。 */
  markGone: () => void;
  /** 收尾。连接还在才 close；close 自身也不抛（async start 的 finally 里抛出去就是 unhandledRejection）。 */
  close: () => void;
}

export function createSseSink(controller: SseController): SseSink {
  const encoder = new TextEncoder();
  let gone = false;

  return {
    get gone() {
      return gone;
    },
    markGone() {
      gone = true;
    },
    emit(e) {
      if (gone) return;
      try {
        controller.enqueue(encoder.encode(encodeSse(e)));
      } catch {
        // 断一次就彻底停发：连接已经没了，后面每一帧都会再抛一次——
        // 继续试只是把同一个异常重复吞 20 遍，还会淹掉真正第一现场的那条日志。
        gone = true;
      }
    },
    close() {
      if (gone) return;
      try {
        controller.close();
      } catch {
        gone = true;
      }
    },
  };
}
