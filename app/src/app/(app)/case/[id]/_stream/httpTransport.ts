'use client';

/**
 * 真端点：POST /api/v1/cases/[id]/chat，Bearer JWT，响应 text/event-stream。
 * 非流错误统一 {ok:false, error_code, message, retry_after?}，在这里归一成 error 帧。
 */

import type { ErrorFrame, StreamFrame } from './frames';
import { readSseFrames } from './sse';
import {
  NeedsDemoFallbackError,
  type ChatRequest,
  type ChatTransport,
} from './transport';

/** 登录成功后写在这里；mock 登录不写，所以现在恒为空 → 一律走演示数据。 */
export const TOKEN_STORAGE_KEY = 'lawer.token';

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // 隐私模式下不可读，按未登录处理
    return null;
  }
}

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
  };
}

export function createHttpTransport(): ChatTransport {
  return {
    kind: 'http',
    async *send({ caseId, message, mode, signal }: ChatRequest) {
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
        body: JSON.stringify(mode ? { message, mode } : { message }),
      });

      if (res.status === 401) throw new NeedsDemoFallbackError('unauthorized');

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
