// app/src/app/api/v1/auth/google/callback/route.ts
// GET /api/v1/auth/google/callback?code=&state= → 校 state、换 token、归并/建号 →
// 302 回登录页，结果（JWT 或三段式错误原文）走 URL fragment 交给前端。
//
// 这是浏览器从 Google 跳回来落地的页面，所以成败都用 302 而不是 JSON：
// 回一段 JSON 就是把用户扔在一个白屏上，让他自己想办法回到站里。
import { NextResponse } from 'next/server';

import {
  GOOGLE_STATE_COOKIE,
  clearStateCookieHeader,
  completeGoogleCallback,
  failureLandingUrl,
  isGoogleOauthEnabled,
  readCookie,
  readGoogleConfig,
  successLandingUrl,
} from '@/lib/auth';
import { failureResponse } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

/** 同 start：每次回调都要读 cookie、写库、签发 token，缓存这个响应等于把别人的登录态发给下一个人 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  // 与 start 同一处置：开关关着 = 这条路由不存在（见 start/route.ts 的注释）
  if (!isGoogleOauthEnabled()) return new NextResponse(null, { status: 404 });

  const config = readGoogleConfig();
  if (!config.ok) return failureResponse(config);

  const url = new URL(req.url);
  const result = await completeGoogleCallback(getDb(), config.config, {
    code: url.searchParams.get('code') ?? '',
    state: url.searchParams.get('state') ?? '',
    cookieState: readCookie(req.headers.get('cookie'), GOOGLE_STATE_COOKIE),
    error: url.searchParams.get('error') ?? undefined,
  });

  const location = result.ok
    ? successLandingUrl(config.config, result.token, result.isNew)
    : failureLandingUrl(config.config, result);

  const res = NextResponse.redirect(location, 302);
  // 用完即焚：成败都清掉 state cookie，一个 state 只能换一次登录
  res.headers.append('set-cookie', clearStateCookieHeader(config.config));
  return res;
}
