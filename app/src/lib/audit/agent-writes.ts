// app/src/lib/audit/agent-writes.ts
// agent_writes 的**唯一写入点**：不管这次写入是从 MCP 工具进来的，还是从 REST 端点直接进来的，
// 台账那一行都由这里插。
//
// 【为什么要收成一个入口（2026-09-07 case 2 事故）】此前只有能力壳（withClientRef）在记台账，
// 而 REST 面上那十几条端点是自己调领域函数写库的——于是同一把 api key，走 MCP 写进去的动作
// 在台账里查得到，走 REST 写进去的查不到。两边都返回 200、都没有一处报错，
// 只有在事后追「这条是谁写的」时才发现台账是残的，而那时归因得靠翻应用日志绕一圈。
// 「独立写 N 次就会忘 N 次」的老形态：这次忘的不是幂等，是审计。
//
// 【endpoint / method 记的是「从哪道门进来的」】
//   · REST：endpoint = 路由的对外路径（如 /api/v1/evidence），method = HTTP 方法；
//   · MCP ：endpoint = `mcp:<工具名>`，method = POST（tools/call 就是一次 POST /api/mcp）。
// 走 REST 但把活交给能力注册表的那几条端点（如 POST /cases/{id}/actions），台账由能力壳记，
// endpoint 因此是 `mcp:<工具名>`——那一行说的是「这次写入是那条能力干的」，
// 而它确实就是同一条能力、同一份实现。不在两处各记一行：一次写入记两行会让计数说谎。
//
// 【为什么老行没有 UPDATE 回填】本仓的迁移框架没有事务，migrate.ts 禁止数据回填
//（见 lib/db/__tests__/migrate-idempotency-guard.test.ts 的 UPDATE-SET 规则）。
// 所以两列都可空，「本列落地之前的行」在**读侧**归一：见 migrate.ts 里的视图
// agent_writes_audit（endpoint 为空即按 `mcp:` || tool 读，method 为空即按 POST 读）——
// 那些行本来就全是能力壳写的，除了 MCP 没有第二个来源。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（由 lib/capabilities/__tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────
import type { Database } from 'better-sqlite3';

import type { Identity } from '@/lib/auth/identity';

/** MCP 面的 endpoint 前缀。REST 面写路径，MCP 面写工具名，靠这个前缀分辨。 */
export const MCP_ENDPOINT_PREFIX = 'mcp:';

/** 工具名 → MCP 面的 endpoint 串。别在调用点手拼前缀（拼错了两处对不上，且不会报错）。 */
export function mcpEndpoint(tool: string): string {
  return `${MCP_ENDPOINT_PREFIX}${tool}`;
}

/**
 * endpoint → tool 列的值。
 *
 * tool 是这张表的**旧列且 NOT NULL**，幂等索引 uq_agent_writes_client_ref 建在
 * (case_id, tool, client_ref) 上，既有读侧（如 lib/drafts/export.ts 的 `tool='draft_export'`）
 * 也认它。所以能力壳那侧的取值必须**一个字节不变**：`mcp:x` 回 `x`。
 * REST 面没有工具名，用「方法 + 路径」当它——两条端点因此不会共用同一个 tool 值。
 */
export function toolOfEndpoint(endpoint: string, method: string): string {
  return endpoint.startsWith(MCP_ENDPOINT_PREFIX)
    ? endpoint.slice(MCP_ENDPOINT_PREFIX.length)
    : `${method} ${endpoint}`;
}

export interface AgentWriteInput {
  /** 走 api key 的写入带它；网页登录态（JWT）没有 key，留空 */
  keyId?: number | null;
  /** REST 路径（/api/v1/…）或 `mcp:<工具名>` */
  endpoint: string;
  /** HTTP 方法。MCP 面填 POST */
  method: string;
  targetTable: string;
  targetId: number;
  caseId: number;
  clientRef?: string | null;
  deduped?: boolean;
}

/**
 * 写一行 agent_writes。**会抛**——这是刻意的：能力壳把它放在 withClientRef 的事务里，
 * 撞上 client_ref 唯一索引时要靠这一抛把整段（业务写入 + 台账）回滚掉，
 * 在这里吞掉异常等于允许双写。
 *
 * REST 路由不要直接调它，调 recordAgentWriteFromRest（那层管身份判定与吞异常）。
 */
export function recordAgentWrite(db: Database, input: AgentWriteInput): void {
  const clientRef =
    typeof input.clientRef === 'string' && input.clientRef.trim() ? input.clientRef.trim() : null;
  db.prepare(
    'INSERT INTO agent_writes' +
      ' (case_id, key_id, tool, client_ref, target_table, target_id, deduped, endpoint, method)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    input.caseId,
    input.keyId ?? null,
    toolOfEndpoint(input.endpoint, input.method),
    clientRef,
    input.targetTable,
    input.targetId,
    input.deduped ? 1 : 0,
    input.endpoint,
    input.method,
  );
}

/**
 * REST 路由记一行台账。**在写入成功之后调**，参数取真正落库的那一行。
 *
 * 两条与 recordAgentWrite 不同的规矩，都只在 REST 这一侧成立：
 *
 * 1. **网页登录态（jwt）不落行**，与本表落地时的口径一致（key_id 可空是给 MCP 侧留的，
 *    不是给网页留的）。这张表回答的是「用户接进来的那个 agent 都写了什么」——
 *    把用户自己在页面上点的每一次操作也灌进来，真正要看的那些行会被淹掉。
 *
 * 2. **写台账失败不拖垮主流程**，只 console.error 点名。业务行此刻已经落库了：
 *    这里再抛出去，用户会拿到一个 500，然后重试——于是那次写入真的发生了两遍。
 *    台账少一行是可查的（对得上日志里这一句），业务多一行是查不回来的。
 */
export function recordAgentWriteFromRest(
  db: Database,
  identity: Identity,
  input: Omit<AgentWriteInput, 'keyId'>,
): void {
  if (identity.via !== 'api_key') return;
  try {
    recordAgentWrite(db, { ...input, keyId: identity.keyId ?? null });
  } catch (err) {
    // 点名到「哪条端点、哪个案子、哪一行」——只打一句 "audit failed" 的形态是：
    // 事后拿着这句日志，既不知道漏了哪次写入，也没法把它补回去。
    console.error(
      `[agent_writes] 台账未记入：${input.method} ${input.endpoint}` +
        ` case_id=${input.caseId} target=${input.targetTable}#${input.targetId}` +
        ` key_id=${identity.keyId ?? '-'}。业务写入已经成功，缺的只是审计行；` +
        `补记要靠这条日志。原因：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
