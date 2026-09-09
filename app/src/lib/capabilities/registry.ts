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
  | 'referral';

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
