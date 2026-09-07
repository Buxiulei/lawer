// app/src/lib/auth/guard.ts
// REST 路由的统一入口闸门：解析身份 → 校验 scope → 交出 Identity。
// 让每条业务路由只剩「取参数 → 调 lib → 返回」，鉴权分支不在路由里重复写。
import { NextResponse } from 'next/server';

import { apiJson } from '@/lib/http/json';
import type { Database } from 'better-sqlite3';

// 直接引那张常量表而不是 lib/capabilities 的门面：error-codes.ts 自己一个 import 都没有，
// 引它不会把注册表（以及它引的整条链）拖进每一条路由；而状态码抄第二份的形态是——
// 同一道闸在 REST 上回 403、在 MCP 上回 400，两边都"正常"，对方 agent 按状态码分支就分岔了。
import { ERROR_CODES } from '@/lib/capabilities/error-codes';
import { CONSENT_KINDS, REALNAME_EXITS } from '@/lib/consent';
import { hasConsent } from '@/lib/db/consents';
import * as users from '@/lib/db/otp';
import type { Scope } from './api-key';
import { hasScope, resolveIdentity, type Identity } from './identity';
import { AUTH_STATUS } from './realname';

/** 失败时给的是可直接 return 的 Response，成功时给 Identity */
export type GuardResult = { ok: true; identity: Identity } | { ok: false; response: NextResponse };

/** 只判过不过的闸门，过了没有额外产物 */
export type GateResult = { ok: true } | { ok: false; response: NextResponse };

function deny(status: number, errorCode: string, message: string): NextResponse {
  return apiJson({ ok: false, error_code: errorCode, message }, { status });
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
 * 实名闸门（spec D1 / §7 users.auth_status）。**异步**：本地没实名时会去问一次 NBDpsy
 * （实名互认，设计稿 §14），对方不可用则按未实名处理。判定本身见 realnameVerifiedOrLinked。
 *
 * 【范围】卡住会**对外产生法律效力**、或必须与本人身份绑定的出口，别往外扩：
 *   1. 证据上传      POST /api/v1/evidence                    —— 已挂（未实名的证据无法保存、无法出证）
 *   2. 证据固化出证  POST /api/v1/evidence/{id}/attest        —— 已挂
 *   3. 文书导出 PDF  MCP draft_export                        —— 已挂（由能力注册表的 precondition 统一拦）
 *   4. 分享链接创建  MCP share_create                         —— 同上；撤销不挂，理由见该条目注释
 * 聊天、问诊不卡：目标用户在最慌的时候进来，先让他把事说出来。到了把材料存进证据库这一步
 * 才要实名——存进来的每一份都要能与本人身份绑定，未实名的证据既无法保存、日后也无法出证。
 *
 * 待审（H5 认证发起了但人没做完）与未认证同等对待——只有落定的「已实名」才放行。
 *
 * message 可按调用档位定制（上传档给的是「上传前先实名」那条自述三段式）；
 * 不传就用出证/对外文书那条通用文案。判定逻辑只有这一份，别在路由里复制第二份。
 */
export async function requireRealname(
  db: Database,
  identity: Identity,
  message = '这一步需要先完成实名认证：出证与对外文书要与本人身份绑定',
): Promise<GateResult> {
  const gate = await realnameGate(db, identity.uid);
  if (gate.ok) return { ok: true };
  // 两条出路一律跟在自述的第三段上：只说"去实名"的形态是——一个已经在 NBDpsy
  // 认证过的人被要求再认证一次，而他有一条一步就能走完的路（见 lib/consent.ts）。
  return {
    ok: false,
    response: deny(gateStatus(gate.errorCode), gate.errorCode, `${message}。${REALNAME_EXITS}`),
  };
}

/** 闸门错误码 → HTTP 状态：以对外错误码表为准（那张表就是对方 agent 读到的说明书）。 */
function gateStatus(code: string): number {
  return ERROR_CODES.find((e) => e.code === code)?.status ?? 403;
}

/**
 * 实名闸的三态判定（协议 三.3 / 附一 #3）。**闸门与能力层的唯一判定入口。**
 *
 * 三态而不是布尔，是因为"没过闸"有两个完全不同的原因，对应两条不同的路：
 *   · REALNAME_REQUIRED —— 本地没实名，对面也没有可采用的认证 → 去认证；
 *   · CONSENT_REQUIRED  —— 对面认过了，但用户还没单独同意我们采用它 → 点一下同意。
 * 把它们压成同一个 false 的形态是：第二种人被反复要求"去实名认证"，
 * 而他真正要做的只是勾一个框——而这两句话在页面上、在对方 agent 的回包里长得一模一样。
 *
 * 【为什么"问对方"发生在没同意的时候也照做】问的是「这个手机号在你们那儿实名了没有」，
 * 与采用是两件事（peekNbdpsyRealname 只问不写）。不问就答不出上面那两态的区别，
 * 于是协议三.3 承诺的"我们会向你说明并征求同意"这句话没有触发的时机。
 * 采用（写库、落姓名与掩码证件号）仍然只在拿到同意之后发生。
 */
export type RealnameGateOutcome =
  | { ok: true }
  | { ok: false; errorCode: 'REALNAME_REQUIRED' | 'CONSENT_REQUIRED' };

export async function realnameGate(db: Database, uid: number): Promise<RealnameGateOutcome> {
  if (isRealnameVerified(db, uid)) return { ok: true };

  const { adoptNbdpsyRealname, peekNbdpsyRealname } = await import('@/lib/referral/identity-link');
  if (hasConsent(db, uid, CONSENT_KINDS.realnameAdopt)) {
    if (await adoptNbdpsyRealname(db, uid)) return { ok: true };
    // 同意了但对面没有可采用的认证：这是"还没实名"，不是"还没同意"。
    return { ok: false, errorCode: 'REALNAME_REQUIRED' };
  }

  const adoptable = await peekNbdpsyRealname(db, uid);
  return { ok: false, errorCode: adoptable ? 'CONSENT_REQUIRED' : 'REALNAME_REQUIRED' };
}

/**
 * 实名闸的布尔外壳：只回"这次放不放行"。**要区分为什么不放行的，调 realnameGate。**
 *
 * 【2026-09-07 起不再自动采用】本地没实名时仍会问一次 NBDpsy（实名互认，设计稿 §14），
 * 但**采用要先有用户的单独同意**（协议三.3 / consents.kind=realname_adopt）——
 * 判定全在 realnameGate，本函数只把三态压成布尔。
 *
 * 【为什么它是 async、而 isRealnameVerified 仍是同步】互认要发一次网络请求，
 * 这一步天然是异步的。把它塞进 isRealnameVerified 会让那个纯本地判定也变成 Promise，
 * 而全站有若干处只想问「我们自己这边认没认」（比如页面上要不要显示实名入口）。
 * 两个函数各答一个问题：本地认没认 / 这次调用放不放行。
 *
 * 【为什么互认写在这里而不是各个入口】三条 REST 与 MCP 那条各写一遍的形态是——
 * 第五个入口忘了抄那一句，于是同一个已经在对面实名过的人，在四个地方畅通、在第五个
 * 地方被拦，而两边都不报错。判定只有这一处，新入口只要调闸门就自动带上互认。
 *
 * 【为什么用动态 import】互认那一支要用到 lib/evidence（证件号掩码规则）与 lib/nbdpsy，
 * 而本文件被**每一条路由**引着。静态引进来等于让所有路由都拖上这条链；
 * 而绝大多数请求走的是「本地已实名」那一支，根本用不到它。
 */
export async function realnameVerifiedOrLinked(db: Database, uid: number): Promise<boolean> {
  return (await realnameGate(db, uid)).ok;
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
  return apiJson(
    { ok: false, error_code: failure.errorCode, message: failure.message },
    { status: failure.status },
  );
}

/** 路径参数里的 id 解析成正整数，不合法返回 null */
export function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}
