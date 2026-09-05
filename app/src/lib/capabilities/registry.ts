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
  | 'docs';

/** 暴露面：站内 agent / 用户自己的 agent（MCP + REST 同一条） */
export type CapabilitySurface = 'mcp' | 'site';

/**
 * 读 / 写 / 耗算力。scope 管的是「这把 key 有没有权限」，kind 管的是「这次调用会不会
 * 改数据、会不会花钱」——两件事分开记：spend 的能力将来要走报价→确认（§4.2），
 * 而它们的 scope 沿用 case:write（拍板③：api_keys 不细分 spend）。
 */
export type CapabilityKind = 'read' | 'write' | 'spend';

/** 服务端闸门（P3）。空数组 = 无前置。 */
export type CapabilityPrecondition = 'realname' | 'balance';

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
  /** 给人看的短名（MCP tools/list 与 /api/manifest 都带它） */
  title: string;
  description: string;
  /** 手写 JSON Schema 字面量：参数都很浅，引 zod + zod-to-json-schema 不划算 */
  inputSchema: Record<string, unknown>;
  /** 同一能力的 REST 映射；没有对应端点的能力省略 */
  rest?: { method: string; path: string };
  run(db: Database, identity: Identity, args: Record<string, unknown>): unknown | DomainFailure;
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
