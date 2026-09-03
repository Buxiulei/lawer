/**
 * 对话传输层：Mock 与真端点共用同一个接口，组件只认帧、不认来源。
 */

import type { StreamFrame } from './frames';

export interface ChatRequest {
  caseId: string;
  message: string;
  mode?: string;
  signal: AbortSignal;
  /**
   * 重试那一轮：失败那条 assistant 消息的 id。带上它，服务端从库里取回同一句问话重发，
   * **不再插一条新的用户消息**（不带的话档案里会多出一句一模一样的问话）。
   */
  retryOf?: string;
}

export interface ChatTransport {
  kind: 'mock' | 'http';
  send(req: ChatRequest): AsyncIterable<StreamFrame>;
}

/** 没有 JWT / 401：不是错误，是「该回落到演示数据」的信号。 */
export class NeedsDemoFallbackError extends Error {
  constructor(readonly reason: 'no-token' | 'unauthorized') {
    super(reason);
    this.name = 'NeedsDemoFallbackError';
  }
}
