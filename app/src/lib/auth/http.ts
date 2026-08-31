// app/src/lib/auth/http.ts
// 认证路由的响应外壳。四条路由共用，保证错误形状只有一种：
//   { ok: false, error_code, message, retry_after? }  + 对应 HTTP status
// 前端按 error_code 分支，不按 HTTP status 分支（NBDpsy 的既定约定）。
import { NextResponse } from 'next/server';

import { verifyAuthHeader } from './jwt';
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

/**
 * optionalUserId 的三种结局：
 *   number    —— 带了有效 token
 *   null      —— 根本没带 Authorization 头，按匿名处理
 *   'invalid' —— 带了但不作数（伪造 / 过期 / 不是 Bearer），调用方**必须回 401**
 */
export type OptionalUserId = number | null | 'invalid';

/**
 * 邮箱那两条路由的可选身份：既要能匿名登录，又不能让一个失效凭据自动降级成匿名。
 *
 * 这条区分本身就是鉴权强度：若把「带了个过期 token」也当匿名放过去，权限判定就从
 * 「通过 / 不通过」变成了「不通过就换一条路」——凭据过期反而解锁了另一套语义。
 * 所以只有 header **根本不存在**才算匿名；存在但解不出有效 payload 一律 'invalid'。
 */
export function optionalUserId(header: string | null): OptionalUserId {
  if (header === null) return null;
  const payload = verifyAuthHeader(header);
  return payload ? payload.uid : 'invalid';
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
