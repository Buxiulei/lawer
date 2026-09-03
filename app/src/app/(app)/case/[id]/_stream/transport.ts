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

/**
 * 本机没有登录：不是错误，是「该回落到演示数据」的信号——未登录的访客本来就看演示。
 *
 * 【为什么只剩这一支（F-202 复核 MF-1）】原先「登录态失效的 401」也走这里，
 * 于是会话过期之后发一句话，答的是**演示案件的案情**。那一支现在归 SessionExpiredError。
 */
export class NeedsDemoFallbackError extends Error {
  constructor(readonly reason: 'no-token') {
    super(reason);
    this.name = 'NeedsDemoFallbackError';
  }
}

/**
 * 登录态失效（本机原本有 token 却换回 401）。
 *
 * 不是「回落演示数据」的信号，也不该在这一屏画错误卡：token 与失效旗已由
 * _ui/api 的 classifyAuthStatus 处理掉，出路是案件路由 layout 上那道闸门
 * （SessionGate，挂在 case/[id]/layout.tsx 上），整块屏幕这一刻就换成「去登录」。
 * 这里只是把这一轮停下来。
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('session-expired');
    this.name = 'SessionExpiredError';
  }
}
