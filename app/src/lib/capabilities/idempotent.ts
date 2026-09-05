// app/src/lib/capabilities/idempotent.ts
// 写能力的幂等入口（设计稿 P2 / §4.1）。
//
// 【为什么是一个入口，不是每个工具各写一遍】幂等这件事独立写 N 次就会忘 N 次，
// 而忘掉之后的形态是：agent 重试一次，用户档案里多一条——返回 200、格式完全正常，
// 没有任何一处报错，只有用户某天翻时间线时发现自己被裁了两次。
// 所以「同案 + 同工具 + 同 client_ref 只算一次」收在这里，由 agent_writes 的
// 部分唯一索引 uq_agent_writes_client_ref 兜底。
//
// 【既有的 timeline_add 不走这里】它有自己的 client_ref 列与索引，早于本表落地、
// 已经在生产上跑着。把它改道过来换不到任何新保证，只换来一次可以不冒的迁移风险。
import type { Database } from 'better-sqlite3';

/** 这次写入落到了哪张表的哪一行。target_table 是弱引用，见 migrate.ts 建表注释。 */
export interface AgentWriteTarget {
  table: string;
  id: number;
}

interface AgentWriteRow {
  target_table: string;
  target_id: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * 幂等地执行一次写入并记账。
 *
 * - 带 client_ref 且已经写过 ⇒ **不再执行 insert**，回既有 target + `deduped: true`；
 *   agent_writes 里始终只有那一行（唯一索引就是这么定的）。
 * - 没带 client_ref ⇒ 照常执行，照常记一行台账（`deduped: false`）。去重交给各自的
 *   自然键——本助手不替调用方猜自然键是什么。
 *
 * 【并发下的保证】整段（查 → 写业务表 → 记台账）在一个事务里，同进程内串行。
 * 跨进程抢同一个 client_ref 时，后到的那笔会撞上唯一索引 ⇒ 整个事务回滚
 *（业务写入一并撤销）⇒ 这里重查一次，回先到那笔的 target。**不会双写**。
 */
export function withClientRef(
  db: Database,
  ctx: {
    caseId: number;
    tool: string;
    clientRef?: unknown;
    /** 走 api key 的写入带它；网页登录态（JWT）没有 key，留空 */
    keyId?: number | null;
  },
  insert: () => AgentWriteTarget,
): { target: AgentWriteTarget; deduped: boolean } {
  const clientRef =
    typeof ctx.clientRef === 'string' && ctx.clientRef.trim() ? ctx.clientRef.trim() : null;

  const findExisting = (): AgentWriteTarget | null => {
    if (clientRef === null) return null;
    const row = db
      .prepare(
        'SELECT target_table, target_id FROM agent_writes WHERE case_id = ? AND tool = ? AND client_ref = ?',
      )
      .get(ctx.caseId, ctx.tool, clientRef) as AgentWriteRow | undefined;
    return row ? { table: row.target_table, id: row.target_id } : null;
  };

  const run = db.transaction((): { target: AgentWriteTarget; deduped: boolean } => {
    const existing = findExisting();
    if (existing) return { target: existing, deduped: true };

    const target = insert();
    db.prepare(
      'INSERT INTO agent_writes (case_id, key_id, tool, client_ref, target_table, target_id, deduped)' +
        ' VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(ctx.caseId, ctx.keyId ?? null, ctx.tool, clientRef, target.table, target.id);
    return { target, deduped: false };
  });

  try {
    return run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = findExisting();
    // 撞了唯一索引却查不回那一行，说明撞的不是 client_ref 这把键（是 insert 自己撞的），
    // 原样抛出去——在这里吞掉会把一个业务约束错误伪装成一次成功的去重。
    if (!existing) throw err;
    return { target: existing, deduped: true };
  }
}
