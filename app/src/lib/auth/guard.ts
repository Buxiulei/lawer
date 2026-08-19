// app/src/lib/auth/guard.ts
// REST 路由的统一入口闸门：解析身份 → 校验 scope → 交出 Identity。
// 让每条业务路由只剩「取参数 → 调 lib → 返回」，鉴权分支不在路由里重复写。
import { NextResponse } from 'next/server';
import type { Database } from 'better-sqlite3';

import type { Scope } from './api-key';
import { hasScope, resolveIdentity, type Identity } from './identity';

/** 失败时给的是可直接 return 的 Response，成功时给 Identity */
export type GuardResult = { ok: true; identity: Identity } | { ok: false; response: NextResponse };

function deny(status: number, errorCode: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error_code: errorCode, message }, { status });
}

/**
 * 要求请求带有效凭据（JWT 或 api key），并具备指定 scope。
 * 401 = 没凭据/凭据无效；403 = 凭据有效但这把 key 没被授予该权限。
 *
 * db 由调用方传入（与 lib/db、lib/cases 一致的约定）：本模块不 import lib/db/client，
 * 否则 `@/lib/auth` 这个 barrel 会连带把 better-sqlite3 和建表逻辑拖进每个引用它的文件。
 */
export function requireIdentity(db: Database, req: Request, scope: Scope): GuardResult {
  const identity = resolveIdentity(db, req.headers);
  if (!identity) {
    return { ok: false, response: deny(401, 'UNAUTHORIZED', '缺少或无效的凭据') };
  }
  if (!hasScope(identity, scope)) {
    return { ok: false, response: deny(403, 'FORBIDDEN_SCOPE', `当前凭据缺少 ${scope} 权限`) };
  }
  return { ok: true, identity };
}

/** 只认网页登录态的接口（api key 不得自我增殖：不能用 key 再造 key） */
export function requireWebSession(db: Database, req: Request): GuardResult {
  const identity = resolveIdentity(db, req.headers);
  if (!identity) {
    return { ok: false, response: deny(401, 'UNAUTHORIZED', '缺少或无效的凭据') };
  }
  if (identity.via !== 'jwt') {
    return {
      ok: false,
      response: deny(403, 'WEB_SESSION_REQUIRED', '管理 api key 只能用网页登录态操作'),
    };
  }
  return { ok: true, identity };
}

/** 领域层失败（lib/cases 的 DomainFailure）转 HTTP 响应，形状与 auth 面保持一致 */
export function domainFailure(failure: {
  status: number;
  errorCode: string;
  message: string;
}): NextResponse {
  return NextResponse.json(
    { ok: false, error_code: failure.errorCode, message: failure.message },
    { status: failure.status },
  );
}

/** 路径参数里的 id 解析成正整数，不合法返回 null */
export function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}
