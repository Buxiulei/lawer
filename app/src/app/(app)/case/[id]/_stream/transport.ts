/**
 * 对话传输层：Mock 与真端点共用同一个接口，组件只认帧、不认来源。
 */

import type { StreamFrame } from './frames';

export interface ChatRequest {
  caseId: string;
  message: string;
  mode?: string;
  signal: AbortSignal;
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
