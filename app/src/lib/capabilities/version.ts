// app/src/lib/capabilities/version.ts
// 注册表内容指纹。`/api/manifest` 的 tools_version 就是它——对方 agent 存下这一串，
// 下次连上发现变了，就知道手上那份说明书可能过期了，该重读 manifest / 接入说明。
//
// 【为什么不是手写的版本号】手写版本号的形态是「改了工具但忘了改版本号」——
// 对方读到同一个号，于是笃定说明书没过期，而它已经过期了。指纹取自内容本身，
// 忘不了：改一个字段，串就变。
//
// 【为什么不进 index.ts 那个门面】本模块引 node:crypto。门面被各处（含可能进客户端
// 打包的路径）引着，把 node 内置模块塞进门面等于给所有引用方加一条 node-only 约束。
// 需要指纹的地方直接引本文件。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

import { CAPABILITIES } from './registry';

/**
 * 递归按键名排序后序列化。**不能直接 JSON.stringify**：inputSchema 是手写字面量，
 * 挪动两个属性的先后（一次纯格式整理）会让指纹变，对方就会白重读一次说明书。
 * 指纹该跟着语义变，不跟着排版变。
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = stable(src[key]);
    return out;
  }
  return value;
}

/**
 * 参与指纹的字段 = 对外可见的那些。`run` 是实现，改它不算说明书变了；
 * 反过来，title / description / inputSchema 是逐字对外的，改一个字就该变号。
 */
function fingerprintable() {
  return CAPABILITIES.map((c) => ({
    name: c.name,
    family: c.family,
    scope: c.scope,
    kind: c.kind,
    domains: c.domains,
    exposeTo: c.exposeTo,
    precondition: c.precondition,
    idempotency: c.idempotency ?? null,
    title: c.title,
    description: c.description,
    inputSchema: c.inputSchema,
    rest: c.rest ?? null,
  }));
}

/** 注册表内容哈希的前 8 位（十六进制） */
export function toolsVersion(): string {
  return createHash('sha256').update(JSON.stringify(stable(fingerprintable()))).digest('hex').slice(0, 8);
}
