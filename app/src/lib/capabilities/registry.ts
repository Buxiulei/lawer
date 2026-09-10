// app/src/lib/capabilities/registry.ts
// 能力注册表（设计稿 §3、P7）：一处定义，三个入口共用——MCP tools/list、REST 路由、
// 站内 agent 的工具集，以及 /api/manifest 与接入说明的能力表，全部由它生成。
// 手写第二份的形态是：用户 agent 拿到的说明书和服务端真实能力悄悄分叉。
//
// ───────────────── ⚠️ 本文件（以及整个 lib/capabilities/）是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（领域名、词表、口径措辞；被拦的词表见守卫）。带领域措辞的对外文案放在
// lib/domains/<key>.ts 的领域包里，由能力条目引用。这条由
// lib/capabilities/__tests__/registry-guard.test.ts 机检。
// ────────────────────────────────────────────────────────────────────────

import type { Database } from 'better-sqlite3';

import type { Scope } from '@/lib/auth/api-key';
import type { Identity } from '@/lib/auth/identity';
import type { DomainFailure } from '@/lib/cases';

import { CAPABILITIES } from './families';

/** 能力所属的族，与 families/ 下的文件一一对应 */
export type CapabilityFamily =
  | 'case'
  | 'timeline'
  | 'actions'
  | 'claims'
  | 'deadlines'
  | 'evidence'
  | 'knowledge'
  | 'drafts'
  | 'company'
  | 'emotion'
  | 'docs'
  | 'report'
  | 'account'
  | 'referral'
  | 'elements';

/** 暴露面：站内 agent / 用户自己的 agent（MCP + REST 同一条） */
export type CapabilitySurface = 'mcp' | 'site';

/**
 * 读 / 写 / 耗算力。scope 管的是「这把 key 有没有权限」，kind 管的是「这次调用会不会
 * 改数据、会不会花钱」——两件事分开记：spend 的能力将来要走报价→确认（§4.2），
 * 而它们的 scope 沿用 case:write（拍板③：api_keys 不细分 spend）。
 */
export type CapabilityKind = 'read' | 'write' | 'spend';

/**
 * 服务端闸门（P3）。空数组 = 无前置。
 *
 * emotion_consent：这条能力要写的是敏感个人信息，用户必须**单独同意过**才放行
 * （协议 五.2（2）/ 附一 #4）。与 realname 同样由注册表驱动、在 invoke 一处拦——
 * 让各能力在自己的 run 里各写一句的形态见 checkPreconditions 抬头。
 *
 * facts_token：这条能力会**按调用方的认知覆盖档案**，所以要先证明它读过当前档案
 * （设计稿 §4.2-4）。只挂在四条高危写能力上；追加/低危写（时间线、情绪）不挂——
 * 挂上去的形态是：一条本该"随手就能记一笔"的路变成了两步，于是模型干脆不记，
 * 而"不落库"正是这套档案最早的那类事故。
 */
export type CapabilityPrecondition = 'realname' | 'balance' | 'emotion_consent' | 'facts_token';

/**
 * 一次能力调用是从**哪道门**进来的。只有这两道门会跑到注册表里的能力：
 *   · `mcp`        —— POST /api/mcp 的 tools/call
 *   · `rest-tools` —— POST /api/v1/tools/{name}（通用工具桥）
 * 台账里 endpoint 那一列按它取值（mcp:<名> / rest-tools:<名>），tool 一列两道门同值。
 *
 * 【为什么不把它和 exposeTo 合成一个字段】exposeTo 答的是「谁看得见这条能力」，
 * 它答的是「这一次是从哪儿调进来的」。合成一个的形态是：以后加一道新门（或某条能力
 * 换了暴露面），台账里的来源跟着乱掉，而两处读起来都像对的。
 */
export type CapabilityEntrance = 'mcp' | 'rest-tools';

/** 一次写入落在哪一行。target_table 是弱引用，见 migrate.ts 的建表注释。 */
export interface CapabilityWriteRow {
  /** agent_writes.case_id 是 NOT NULL 外键，取不到就别回这一行 */
  caseId: number;
  targetId: number;
  /** 业务侧回了「这次是重放，没有新写入」（deduped / already_*）时为 true */
  deduped?: boolean;
}

/**
 * 「**写是写了，但定位不到那一行**」。与空数组（这次一行都没写）是两件事。
 *
 * 【为什么要把这两件事分开（2026-09-10 复审）】有几条能力的入参里没有案件号
 * （分享链接、转介、证据都按自己的 id 定位），台账那一行的 case_id 要回读一次才知道。
 * 回读不到时此前一律回空数组——而空数组的约定是「这次没写东西」，于是记账层照约定
 * 什么都不做、也不说一句：业务侧真的撤销了一条链接 / 真的出了一份证，台账里没有那一行，
 * 而回包 200、日志干净、没有任何一处报错。**未写**与**写了但记不上账**在事后
 * 长得一模一样，那正是台账最不该含糊的地方。
 *
 * 回这个结构 = 请记账层点名（缺什么 / 为什么缺 / 怎么办），并且**不落那一行假的**。
 */
export interface CapabilityWriteUnresolved {
  /** 缺什么：哪个 id 回读不到什么。进日志正文，要点得出名字，不能只说「失败了」 */
  unresolved: string;
}

/** rowsOf 的每一项：要么是定位得到的那一行，要么是一句「回读失败」。 */
export type CapabilityWriteOutcome = CapabilityWriteRow | CapabilityWriteUnresolved;

/**
 * 写能力的**台账元数据**。声明它 = 「这条能力自己不记台账，由跑它的那道门统一记一行」。
 *
 * 走 withClientRef / writeOnce 的写能力**不声明**：它们在自己的事务里记，
 * 再由外面补一行就是同一次写入占两行，计数从此说谎。
 * 「声明 ledger」与「走能力壳」两者恰好互斥、且每条写能力必居其一，
 * 由 __tests__/registry-guard.test.ts 机检——漏声明的形态是那条能力照常工作、
 * 照常返回 200，只是它写进去的东西在台账里查不到，没有任何一处会报错。
 */
export interface CapabilityLedger {
  /** 落到哪张表 */
  targetTable: string;
  /**
   * 这次调用**真正写了哪几行**。
   *
   * 空数组 = 一行都没写（两步确认里只出确认单的那一步、逐件批量里一件都没成），
   * 此时不记台账、也不报警——给「什么都没发生」记一行的形态是：事后复盘时那个不可撤销的动作
   * 在台账里比实际多发生过几次。
   *
   * **写了却定位不到那一行**（要回读的 id 查不着了）回 `{ unresolved }`，
   * 不要拿空数组顶替：空数组是「没写」，两件事混成一件之后，台账缺一行与本来就没有那一行
   * 在事后长得一模一样。见 CapabilityWriteUnresolved。
   *
   * 逐件批量的能力回多行：一次调用只记一行的形态是，台账里那个数永远是 1，
   * 而文件与账单都是 N 件；其中某几件回读不到，就在那几件的位置上回 `{ unresolved }`，
   * 成了的那几件照记。
   */
  rowsOf(
    db: Database,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): CapabilityWriteOutcome[];
}

export interface Capability {
  name: string;
  family: CapabilityFamily;
  /** 调用本能力需要的权限；api key 没有该 scope 即拒绝 */
  scope: Scope;
  kind: CapabilityKind;
  /** ['*'] = 跨领域通用；否则只在列出的领域里可见 */
  domains: readonly string[];
  exposeTo: readonly CapabilitySurface[];
  precondition: readonly CapabilityPrecondition[];
  /** 有幂等约定的写能力才填；读能力恒省略 */
  idempotency?: { clientRef?: boolean; naturalKey?: string };
  /** 不走能力壳（withClientRef / writeOnce）的写能力填它，台账由门统一记。见 CapabilityLedger */
  ledger?: CapabilityLedger;
  /**
   * facts_token 闸**只在这几个入参出现时才开**（省略 = 声明了 facts_token 就恒开）。
   *
   * 【为什么要这一格】有的能力身兼两种动作：case_update 既能改 stage（把案子推进到
   * 下一个程序节点，改错要人工回退），也能补一句 goal 的错别字。整条能力一律挂闸的形态是：
   * 补一个岗位名也要先读一遍事实卡，于是调用方要么多跑一轮，要么干脆绕开这条能力。
   * 只在真正高危的那个入参上开闸，闸才留得住。
   */
  factsTokenArgs?: readonly string[];
  /** 给人看的短名（MCP tools/list 与 /api/manifest 都带它） */
  title: string;
  description: string;
  /** 手写 JSON Schema 字面量：参数都很浅，引 zod + zod-to-json-schema 不划算 */
  inputSchema: Record<string, unknown>;
  /** 同一能力的 REST 映射；没有对应端点的能力省略 */
  rest?: { method: string; path: string };
  /**
   * 执行。**允许返回 Promise**：要调外部服务的能力（出证）天然是异步的。
   * 调用方一律 await——同步的返回值 await 一下也还是它自己。
   */
  run(
    db: Database,
    identity: Identity,
    args: Record<string, unknown>,
  ): unknown | DomainFailure | Promise<unknown | DomainFailure>;
}

/**
 * 按暴露面（必给）与领域（可选）取能力清单。**保持注册表里的原始顺序**：
 * 客户端把工具清单原样展示给用户，重排等于面板重排。
 *
 * domain 不给时不按领域过滤（tools/list 拿不到案件上下文，给的是并集）。
 */
export function listCapabilities(filter: {
  exposeTo: CapabilitySurface;
  domain?: string;
}): Capability[] {
  return CAPABILITIES.filter(
    (c) =>
      c.exposeTo.includes(filter.exposeTo) &&
      (filter.domain === undefined ||
        c.domains.includes('*') ||
        c.domains.includes(filter.domain)),
  );
}

export function getCapability(name: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}

export { CAPABILITIES };
