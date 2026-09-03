'use client';

/**
 * 真端点：POST /api/v1/cases/[id]/chat，Bearer JWT，响应 text/event-stream。
 * 非流错误统一 {ok:false, error_code, message, retry_after?}，在这里归一成 error 帧。
 */

import { classifyAuthStatus } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';

import type { ErrorFrame, StreamFrame } from './frames';
import { readSseFrames } from './sse';
import {
  NeedsDemoFallbackError,
  SessionExpiredError,
  type ChatRequest,
  type ChatTransport,
} from './transport';

/** 登录态由 _ui/auth 统一持有；这里只转出，别再写第二份取 token 的实现。 */
export { TOKEN_STORAGE_KEY } from '@/app/_ui/auth';
export { readToken };

function errorFrameFrom(body: unknown, status: number): ErrorFrame {
  const payload = (body ?? {}) as Record<string, unknown>;
  return {
    type: 'error',
    code: typeof payload.error_code === 'string' ? payload.error_code : `HTTP_${status}`,
    message:
      typeof payload.message === 'string' && payload.message
        ? payload.message
        : '这一轮没能连上，稍后再试一次。',
    retry_after:
      typeof payload.retry_after === 'number' ? payload.retry_after : undefined,
    // 余额（402 GONGDAO_EXHAUSTED 才有）。缺席就是缺席，不补 0——
    // 0 是一个**真实且不同**的余额，凭空造一个会让横幅说出一个服务端没说过的数。
    balance: typeof payload.balance === 'number' ? payload.balance : undefined,
  };
}

export function createHttpTransport(): ChatTransport {
  return {
    kind: 'http',
    async *send({ caseId, message, mode, signal, retryOf }: ChatRequest) {
      const token = readToken();
      if (!token) throw new NeedsDemoFallbackError('no-token');

      const res = await fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/chat`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message,
          ...(mode ? { mode } : {}),
          ...(retryOf ? { retry_of: Number(retryOf) } : {}),
        }),
      });

      /**
       * 登录态这一关不自己判（F-202 复核 MF-1）：这条流用不了 apiFetch，但清 token、
       * 立失效旗、区分「失效」与「没登录」全归 _ui/api 那一个入口。
       * 原先这里是 `NeedsDemoFallbackError('unauthorized')`——会话一过期，
       * 页面就拿**演示案件的案情**当他的答案端出去，还留着那个不作数的 token。
       */
      const verdict = classifyAuthStatus(res.status);
      // 失效：出路归 layout 上那道闸门，这一屏马上整块换成「去登录」
      if (verdict === 'expired') throw new SessionExpiredError();
      // 没登录：演示回落仍然是对的，横幅会说清楚这不是他的档案
      if (verdict === 'signed-out') throw new NeedsDemoFallbackError('no-token');

      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
        const body = await res.json().catch(() => null);
        yield errorFrameFrom(body, res.status);
        return;
      }

      const frames: AsyncIterable<StreamFrame> = readSseFrames(res.body);
      for await (const frame of frames) yield frame;
    },
  };
}
