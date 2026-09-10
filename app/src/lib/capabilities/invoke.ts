// app/src/lib/capabilities/invoke.ts
// 调一条能力所需的**全部服务端判定**，一处实现：暴露面 → scope → 前置闸 → run → 失败归一。
//
// 【为什么要有这一层】此前这套判定只长在 api/mcp/route.ts 里。REST 那面要么各条路由自己
// 抄一遍，要么干脆没有——通用桥若自己写一句 scope 判断、忘了写前置闸，它照常返回 200，
// 未过闸的人从这条路照样写得进去，而 MCP 那条仍然拦得好好的。两条入口对同一条能力给出
// 不同答案，且两边都不报错。所以判定只留这一份，MCP 与 REST 都从这里过。
//
// 本模块**不认识 HTTP 框架**：失败回的是带 status 的普通结构，由各路由渲染成自己的外壳
// （REST 回 JSON body，MCP 回 JSON-RPC 的 isError 结果）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────
import type { Database } from 'better-sqlite3';

import { realnameGate } from '@/lib/auth/guard';
import { hasScope, type Identity } from '@/lib/auth/identity';
import { CONSENT_KINDS, REALNAME_EXITS } from '@/lib/consent';
import { hasConsent } from '@/lib/db/consents';

import { FACTS_TOKEN_WHY, issueFactsToken, verifyFactsToken } from '@/lib/cases/facts-token';

import { ERROR_CODES } from './error-codes';
import { isKnownReplay } from './idempotent';
import { num, renderCurrentFacts } from './shared';
import { getCapability, type Capability, type CapabilitySurface } from './registry';

/**
 * 失败结构与 lib/cases 的 DomainFailure 同形，路由可以原样喂给 domainFailure()。
 *
 * 【为什么带 extra】能力自己在失败对象上挂的结构化清单（如 claim_calc 的 missing / invalid
 * 两张表）要跟着出去。只搬 errorCode + message 的形态是：MCP 那条路（toolErrorResult 收整个
 * 失败对象）读得到那几张表，REST 通用桥读到的是 undefined —— 同一条能力、同一个错，
 * 两条入口给出的回包不一样，而两边都是正常的 4xx，没有任何一处报错。
 */
export interface CapabilityFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
  /** 能力自报的结构化字段，原样透传（键名由该能力的描述向调用方承诺） */
  extra?: Record<string, unknown>;
}

function fail(
  status: number,
  errorCode: string,
  message: string,
  extra?: Record<string, unknown>,
): CapabilityFailure {
  return extra && Object.keys(extra).length > 0
    ? { ok: false, status, errorCode, message, extra }
    : { ok: false, status, errorCode, message };
}

/** error_code → HTTP 状态的正本就是对外错误码表，别在路由里各记一份 */
const STATUS_BY_CODE = new Map(ERROR_CODES.map((e) => [e.code, e.status]));

/**
 * 失败结构该配哪个 HTTP 状态。
 *
 * 顺序是「错误码表 → 领域层自报的 status → 400」：表里登记过的码以表为准（对方 agent
 * 读到的说明书就是那张表，回包与表不一致等于说明书说谎）；表里没有的码（如报价过期这类
 * 只在某一族出现的）用领域层自己给的 status；两者都没有才落到 400。
 */
export function statusForFailure(failure: { status?: unknown; errorCode: string }): number {
  const listed = STATUS_BY_CODE.get(failure.errorCode);
  if (listed !== undefined) return listed;
  const own = failure.status;
  return typeof own === 'number' && own >= 400 && own <= 599 ? own : 400;
}

/**
 * 前置闸（注册表 precondition 字段驱动）。过了回 null。
 *
 * 【为什么不导出（2026-09-10 复审）】它曾经是导出的，于是 MCP 那道门借走这一句、
 * 自己拿着 tool.run 跑完整段——而 args 那一格当时还带着 `= {}` 缺省值，调用点漏传
 * 不会报错，按入参开的闸（facts_token）于是在那道门上恒不开：同一把 key、同一份入参，
 * 一道门 200 真写入、另一道门 409，两边都不报错。现在跑一条能力只有 invokeCapability
 * 一条路，args 也是必填——少传一个参数就少一道闸这种缝，靠"记得传"是堵不住的。
 *
 * 【为什么由注册表驱动而不是各能力自觉】让各能力在自己的 run 里各写一句的形态是：
 * 新加一条写能力时忘了抄那一句——它照常工作、照常返回 200，只是没过闸的人也能写进去，
 * 没有任何一处会报错。
 *
 * 【balance 为什么不在这里拦】余额闸要知道这次动作**值多少钱**，那个数只有能力自己
 * （报价 → 确认）算得出来。在这里拦只能拦「余额 ≤ 0」，既漏掉余额不足以支付本次的情形，
 * 又会把只看价、不扣费的调用一并挡掉。所以扣费类能力的余额判定留在 run 内部，
 * 失败时回 GONGDAO_EXHAUSTED，由 statusForFailure 映到 402。
 *
 * 【realname 闸为什么 async】实名判定走 lib/auth/guard.realnameVerifiedOrLinked 这**唯一
 * 判定入口**：本地没实名时会去问一次 NBDpsy（实名互认，设计稿 §14），对方 approved 就采信
 * 并落一条 provider=nbdpsy 的掩码快照，对方未接通/不可用则按未实名。这一步天然要发网络请求，
 * 所以本函数是 async。证据 REST 那面（requireRealname）与这里调的是同一个判定——
 * 各写一份的形态是：一个已在对面实名过的人，在证据 REST 侧放行、在 MCP/通用桥侧被 403，
 * 而两边都不报错。判定只留这一份，两条入口自动同口径。
 */
async function checkPreconditions(
  db: Database,
  capability: Capability,
  identity: Identity,
  args: Record<string, unknown>,
): Promise<CapabilityFailure | null> {
  if (capability.precondition.includes('realname')) {
    const gate = await realnameGate(db, identity.uid);
    if (!gate.ok) {
      return fail(
        statusForFailure({ errorCode: gate.errorCode }),
        gate.errorCode,
        `${capability.name} 需要账号先完成实名认证，本次调用没有产生任何写入。` +
          '原因是这一步的产物要与本人身份绑定（材料要能证明是谁存的，出证上要印实名快照）。' +
          `${REALNAME_EXITS}` +
          '两条都在网页上做，做完再调一次；' +
          '在那之前不要改用别的工具绕开这一步，绕过去的记录日后不能用于出证。',
      );
    }
  }
  if (
    capability.precondition.includes('emotion_consent') &&
    !hasConsent(db, identity.uid, CONSENT_KINDS.emotion)
  ) {
    return fail(
      statusForFailure({ errorCode: 'CONSENT_REQUIRED' }),
      'CONSENT_REQUIRED',
      `${capability.name} 要记录的是敏感个人信息（可以推知心理健康状况），` +
        '用户还没有对这件事单独同意过，本次调用**没有写入任何东西**。' +
        '请把这件事按原样念给用户听：记什么（档位、时间、你说过的那一句依据）、' +
        '为什么记（判断要不要给心理支持的信息与转介）、不同意的后果（不记，其余功能照常）。' +
        '同意要由用户本人在网页上给（设置 → 隐私与同意），不要替他点头，也不要改参数重试。',
    );
  }
  if (capability.precondition.includes('facts_token')) {
    const gate = checkFactsToken(db, capability, identity, args);
    if (gate) return gate;
  }
  return null;
}

/**
 * facts_token 闸（设计稿 §4.2-4）。过了回 null。
 *
 * 【为什么错误体里要夹整张事实卡与一枚新令牌】只回一句「令牌过期」的形态是：
 * 对方 agent 要么盲目重试（同一份内容再写一遍，照样过期），要么放弃这次写入并
 * 告诉用户"系统不让写"。夹上事实卡它就能**当场**核对自己要写的东西还成不成立，
 * 夹上新令牌它就能一次重试成功——禁令配出路（设计稿 §7.7），出路要在错误体里，
 * 不在文档里。
 *
 * 【为什么新令牌就是照着当前事实卡签的】它证明的是"你手上这份认知等于当前状态"，
 * 而这一刻我们刚把当前状态整份交给它。发一枚"要它再读一次才有效"的令牌没有任何多余保证，
 * 只多一轮往返；而对方拿到卡之后不看就写，那是它的转述错误率问题（§4.5-4 专项在观测），
 * 不是这道闸挡得住的东西。
 */
function checkFactsToken(
  db: Database,
  capability: Capability,
  identity: Identity,
  args: Record<string, unknown>,
): CapabilityFailure | null {
  // 只在点名的入参出现时开闸（省略 factsTokenArgs = 恒开）。
  const watched = capability.factsTokenArgs;
  if (watched && !watched.some((name) => args[name] !== undefined)) return null;

  const caseId = num(args.case_id);
  // case_id 不合法时**不在这里报错**：那是该能力自己的入参校验，由它回 INVALID_CASE_ID。
  // 在这里抢先报一个 FACTS_STALE 的形态是：调用方照着"去读事实卡"的指引走，
  // 读完再来，还是同一个错——而真正的问题从头到尾是那个 case_id。
  if (!Number.isInteger(caseId) || caseId <= 0) return null;

  // **已经写过的那个 client_ref 直接放行**：重放不改变任何东西，而它手上那枚令牌
  // 正是被第一次写入弄失效的（理由见 idempotent.isKnownReplay 的长注释）。
  if (isKnownReplay(db, { caseId, tool: capability.name, clientRef: args.client_ref })) return null;

  const facts = renderCurrentFacts(db, caseId, identity.uid);
  // 归属不过（案件不存在或不是本人的）同样让位给能力自己的 404：
  // 这道闸不该成为第二个"这个案件号存不存在"的探针。
  if (!facts.ok) return null;

  const check = verifyFactsToken(args.facts_token, facts.text);
  if (check.ok) return null;

  const triggeredBy = watched?.length
    ? `本次调用带了 ${watched.filter((n) => args[n] !== undefined).join(' / ')}，属于会覆盖档案的那一类动作。`
    : '';
  return fail(
    statusForFailure({ errorCode: 'FACTS_STALE' }),
    'FACTS_STALE',
    `${capability.name} 这次**没有写入任何东西**。${triggeredBy}` +
      `${FACTS_TOKEN_WHY[check.reason]}` +
      '怎么办：下面 `case_facts` 是此刻档案的事实卡全文，`facts_token` 是配套的新令牌——' +
      '先按这份事实卡核一遍你要写的内容还成不成立（变了就改，别原样重发），' +
      '再带上这枚新令牌调一次。不要自己拼令牌，也不要换别的工具绕开这一步。',
    { case_facts: facts.text, facts_token: issueFactsToken(facts.text) },
  );
}

export type CapabilityOutcome =
  | { ok: true; value: Record<string, unknown> }
  | CapabilityFailure;

/**
 * 按名调一条能力：认不认这个名 → 这把凭据够不够权限 → 前置闸 → 跑。
 *
 * @param surface 只在这个暴露面上可见的能力才认；别的名字一律当作不存在
 *   （不回「有这个能力但你走错门了」——那等于把不对外的能力清单念给对方听）。
 *
 * 【为什么 await】要调外部服务的能力（出证一类）返回的是 Promise。不 await 的形态是：
 * 回包里是一个 {}（序列化后的 Promise），HTTP 200，没有任何报错。
 */
export async function invokeCapability(
  db: Database,
  identity: Identity,
  name: string,
  args: Record<string, unknown>,
  surface: CapabilitySurface = 'mcp',
): Promise<CapabilityOutcome> {
  const capability = getCapability(name);
  if (!capability || !capability.exposeTo.includes(surface)) {
    return fail(404, 'TOOL_NOT_FOUND', `没有名为 ${name} 的能力。可调用的清单见 GET /api/v1/tools。`);
  }
  if (!hasScope(identity, capability.scope)) {
    return fail(403, 'FORBIDDEN_SCOPE', `当前凭据缺少 ${capability.scope} 权限`);
  }
  const gate = await checkPreconditions(db, capability, identity, args);
  if (gate) return gate;

  const outcome = await capability.run(db, identity, args);
  if (outcome && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok === false) {
    const failure = outcome as { status?: unknown; errorCode: string; message: string } & Record<
      string,
      unknown
    >;
    // ok / status / errorCode / message 是路由分档与人读的部分，其余键一律原样带走
    const { ok: _ok, status: _status, errorCode: _code, message: _msg, ...extra } = failure;
    void _ok;
    void _status;
    void _code;
    void _msg;
    return fail(statusForFailure(failure), failure.errorCode, failure.message, extra);
  }
  return { ok: true, value: (outcome ?? {}) as Record<string, unknown> };
}
