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

import { isRealnameVerified } from '@/lib/auth/guard';
import { hasScope, type Identity } from '@/lib/auth/identity';

import { ERROR_CODES } from './error-codes';
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
 * 【为什么由注册表驱动而不是各能力自觉】让各能力在自己的 run 里各写一句的形态是：
 * 新加一条写能力时忘了抄那一句——它照常工作、照常返回 200，只是没过闸的人也能写进去，
 * 没有任何一处会报错。
 *
 * 【balance 为什么不在这里拦】余额闸要知道这次动作**值多少钱**，那个数只有能力自己
 * （报价 → 确认）算得出来。在这里拦只能拦「余额 ≤ 0」，既漏掉余额不足以支付本次的情形，
 * 又会把只看价、不扣费的调用一并挡掉。所以扣费类能力的余额判定留在 run 内部，
 * 失败时回 GONGDAO_EXHAUSTED，由 statusForFailure 映到 402。
 */
export function checkPreconditions(
  db: Database,
  capability: Capability,
  identity: Identity,
): CapabilityFailure | null {
  if (capability.precondition.includes('realname') && !isRealnameVerified(db, identity.uid)) {
    return fail(
      403,
      'REALNAME_REQUIRED',
      `${capability.name} 需要账号先完成实名认证，本次调用没有产生任何写入。` +
        '原因是这一步的产物要与本人身份绑定（材料要能证明是谁存的，出证上要印实名快照）。' +
        '请让用户到网页「设置 → 实名认证」完成认证后再调一次；' +
        '认证前不要改用别的工具绕开这一步，绕过去的记录日后不能用于出证。',
    );
  }
  return null;
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
  const gate = checkPreconditions(db, capability, identity);
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
