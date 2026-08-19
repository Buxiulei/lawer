// app/src/lib/auth/http.ts
// 认证路由的响应外壳。四条路由共用，保证错误形状只有一种：
//   { ok: false, error_code, message, retry_after? }  + 对应 HTTP status
// 前端按 error_code 分支，不按 HTTP status 分支（NBDpsy 的既定约定）。
import { NextResponse } from 'next/server';

import type { AuthFailure } from './otp';

export function failureResponse(failure: AuthFailure): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_code: failure.errorCode,
      message: failure.message,
      ...(failure.retryAfter === undefined ? {} : { retry_after: failure.retryAfter }),
    },
    { status: failure.status },
  );
}

export function badRequest(errorCode: string, message: string): NextResponse {
  return failureResponse({ ok: false, status: 400, errorCode, message });
}

export function unauthorized(): NextResponse {
  return failureResponse({
    ok: false,
    status: 401,
    errorCode: 'UNAUTHORIZED',
    message: '登录状态已失效，请重新验证手机号',
  });
}

/** 读请求体；不是合法 JSON 对象时返回 null，由调用方回 400 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 取字符串字段，缺失或类型不对返回空串（后续由业务校验给出具体 error_code） */
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}
