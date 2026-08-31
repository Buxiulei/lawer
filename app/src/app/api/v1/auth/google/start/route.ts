// app/src/app/api/v1/auth/google/start/route.ts
// GET /api/v1/auth/google/start → 302 到 Google 授权页，并下发一次性 state cookie。
// 浏览器直接跳到这个地址（是页面跳转不是 fetch），所以这里回的是 302 不是 JSON。
import { NextResponse } from 'next/server';

import {
  buildAuthorizeUrl,
  createOauthState,
  isGoogleOauthEnabled,
  readGoogleConfig,
  stateCookieHeader,
} from '@/lib/auth';
import { failureResponse } from '@/lib/auth/http';

/**
 * 绝不能被静态化/缓存。本路由每次必须产出**新的** state 并配套下发 cookie；
 * 一旦这个响应被缓存，所有人拿到的是同一个 state 和同一条 Set-Cookie，
 * 防 CSRF 就整体失效了（攻击者也能拿到那个 state）。
 * 当前 Next 版本默认就是动态的，但这条性质太要紧，不留给框架默认值。
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // 开关关着时**整条路由当作不存在**：回空体 404，而不是「功能未开放」之类的说明。
  // 暗启期间连"这里将来有个 Google 登录"都不该从响应里读出来。
  if (!isGoogleOauthEnabled()) return new NextResponse(null, { status: 404 });

  const config = readGoogleConfig();
  if (!config.ok) return failureResponse(config);

  const state = createOauthState();
  const res = NextResponse.redirect(buildAuthorizeUrl(config.config, state), 302);
  res.headers.append('set-cookie', stateCookieHeader(config.config, state));
  return res;
}
