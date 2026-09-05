// app/src/lib/capabilities/shared.ts
// 各族能力共用的入参小工具与片段。从 lib/mcp/tools.ts 原样搬来，行为逐字不变。
import type { Database } from 'better-sqlite3';

import type { DomainFailure } from '@/lib/cases';

import { withClientRef, type AgentWriteTarget } from './idempotent';

/** case_id 在多数能力里都是必填整数，抽出来免得七份重复 */
export const caseIdProp = {
  case_id: { type: 'integer', description: '案件 id' },
} as const;

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

/**
 * 元 → 分。对着人给的是「元」，落库口径全仓是「分」（*_fen）。
 * 非数一律回 NaN，交给领域层的 INVALID_MONTHLY_WAGE 报字段级错，不在这里静默兜底成某个数。
 * 有些客户端把入参一律序列化成字符串，故数字串也认。
 */
export function yuanToFen(value: unknown): number {
  const yuan =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(yuan) ? Math.round(yuan * 100) : Number.NaN;
}

/**
 * 写能力的统一外壳：**领域函数成功才记台账，失败连同台账一起回滚。**
 *
 * 【为什么不是「先调领域函数、成了再记一笔」】那样写在正常路径上看不出问题，
 * 出问题的是两步之间：业务行已经落库、记台账时进程被杀，于是这次写入在台账里不存在——
 * 客户端拿同一个 client_ref 重试，去重查不到那一行，用户档案里就多了一条一模一样的。
 * 这里把两件事放进同一个事务（withClientRef 内部），要么都有要么都没有。
 *
 * 【领域失败怎么回滚】领域函数回的是值（ok:false）不是异常，事务不会自己撤销。
 * 所以这里把失败包成一个私有异常抛出去让事务回滚，在外面拆回原来那个失败结构——
 * 调用方看到的仍是普通的 DomainFailure，一个字都没变。
 */
class DomainAbort extends Error {
  constructor(readonly failure: DomainFailure) {
    super('DOMAIN_FAILURE');
  }
}

/** 重放命中时的说明。客户端要如实告诉用户「这条之前已经写过了」，不要当成又写了一条。 */
export const DEDUPED_NOTE =
  '这次调用与之前某次用了同一个 client_ref，服务端按上次的结果返回，未重复写入。';

export function writeOnce<T extends { ok: true }>(
  db: Database,
  ctx: { caseId: number; tool: string; clientRef?: unknown; keyId?: number | null },
  exec: () => T | DomainFailure,
  targetOf: (result: T) => AgentWriteTarget,
):
  | (T & { deduped: false })
  | { ok: true; deduped: true; id: number; note: string }
  | DomainFailure {
  let fresh: T | undefined;
  try {
    const outcome = withClientRef(db, ctx, () => {
      const res = exec();
      if (res.ok !== true) throw new DomainAbort(res);
      fresh = res;
      return targetOf(res);
    });
    if (!outcome.deduped && fresh) return { ...fresh, deduped: false };
    // 重放命中：exec 根本没跑，手上只有上次落在哪一行。回 id 让调用方自己去读那一行，
    // 不去替它重新拼一份"上次大概是什么样"的载荷——那份东西没人核对得了。
    return { ok: true, deduped: true, id: outcome.target.id, note: DEDUPED_NOTE };
  } catch (err) {
    if (err instanceof DomainAbort) return err.failure;
    throw err;
  }
}
