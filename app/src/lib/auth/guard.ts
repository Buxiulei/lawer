// app/src/lib/auth/guard.ts
// REST 路由的统一入口闸门：解析身份 → 校验 scope → 交出 Identity。
// 让每条业务路由只剩「取参数 → 调 lib → 返回」，鉴权分支不在路由里重复写。
import { NextResponse } from 'next/server';
import type { Database } from 'better-sqlite3';

import * as users from '@/lib/db/otp';
import type { Scope } from './api-key';
import { hasScope, resolveIdentity, type Identity } from './identity';
import { AUTH_STATUS } from './realname';

/** 失败时给的是可直接 return 的 Response，成功时给 Identity */
export type GuardResult = { ok: true; identity: Identity } | { ok: false; response: NextResponse };

/** 只判过不过的闸门，过了没有额外产物 */
export type GateResult = { ok: true } | { ok: false; response: NextResponse };

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

/**
 * 实名闸门（spec D1 / §7 users.auth_status）。
 *
 * 【范围】卡住会**对外产生法律效力**、或必须与本人身份绑定的出口，别往外扩：
 *   1. 证据上传      POST /api/v1/evidence                    —— 已挂（未实名的证据无法保存、无法出证）
 *   2. 证据固化出证  POST /api/v1/evidence/{id}/attest        —— 已挂
 *   3. 文书导出 PDF  （drafts 导出路由尚未实现）              —— 待该路由落地时挂上
 *   4. 分享链接创建  （share_links 创建路由尚未实现）          —— 同上
 * 聊天、问诊不卡：目标用户在最慌的时候进来，先让他把事说出来。到了把材料存进证据库这一步
 * 才要实名——存进来的每一份都要能与本人身份绑定，未实名的证据既无法保存、日后也无法出证。
 *
 * 待审（H5 认证发起了但人没做完）与未认证同等对待——只有落定的「已实名」才放行。
 *
 * message 可按调用档位定制（上传档给的是「上传前先实名」那条自述三段式）；
 * 不传就用出证/对外文书那条通用文案。判定逻辑只有这一份，别在路由里复制第二份。
 */
export function requireRealname(
  db: Database,
  identity: Identity,
  message = '这一步需要先完成实名认证：出证与对外文书要与本人身份绑定',
): GateResult {
  if (isRealnameVerified(db, identity.uid)) return { ok: true };
  return { ok: false, response: deny(403, 'REALNAME_REQUIRED', message) };
}

/**
 * 同一道闸的判定本身，不带 HTTP 外壳。
 *
 * 【为什么要把它单独露出来】MCP 那条路回的是 JSON-RPC 的 toolError，不是 NextResponse，
 * 拿不了上面那个 GateResult。若在 MCP 路由里另写一句 `auth_status === '已实名'`，
 * 判定就有了第二份——哪天口径变了（比如多一档"已实名但已冻结"），
 * 改一处漏一处的形态是：网页拦住了，agent 那条还放行，而两边都不报错。
 */
export function isRealnameVerified(db: Database, uid: number): boolean {
  return users.findUserById(db, uid)?.auth_status === AUTH_STATUS.verified;
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
