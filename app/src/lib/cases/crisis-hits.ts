// app/src/lib/cases/crisis-hits.ts
// 危机信号命中的**唯一落库入口**（设计稿 §4.4）。
//
// 【为什么只许有一个入口】站内对话与用户自己的 agent 是同一个人的两条入口，
// 而"命中了要记一笔"这件事独立写两次就会忘一次。忘掉之后的形态最难发现：
// 用户白天在自己的助手里说了那句话、晚上回站内来，事实卡首行干干净净——
// 我们表现得像从没听见过，而两条通路各自看起来都在正常工作。
// 所以两边都调 recordCrisisHit，谁都不许自己写一句 INSERT INTO crisis_hits。
//
// 【为什么存哈希不存原话】命中词与用户原话是这个库里最敏感的一段文本，
// 而首行标记只需要回答「有没有、几次」。terms_hash 让"是不是同一句话反复触发"
// 仍然看得出来（同一组词稳定同值），但反推不回那句话。
//
// 【为什么不并进 lib/cases/index.ts】调它的是 lib/agent 的对话主循环与能力层，
// 两边都不需要 index.ts 那一整套归属校验与领域写入口；单独一个文件只依赖 Database，
// 与 report-stale.ts 同样的理由（见该文件头）。
import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { toSql } from '../db/time';

/** 命中来自哪条通路。值域只有两个，与 crisis_hits.source 列注释同源。 */
export type CrisisHitSource = 'site' | 'mcp';

/**
 * 事实卡首行「近 N 小时有危机信号」的窗口（设计稿 §4.4 定 72 小时）。
 * 写成常量而不是散在 SQL 里的 '-72 hours'：判据要按同一个数造"刚好超窗"的样本。
 */
export const CRISIS_HIT_WINDOW_HOURS = 72;

const WINDOW_MS = CRISIS_HIT_WINDOW_HOURS * 60 * 60 * 1000;

/** 命中词 → 稳定哈希。按**首现序**拼接：assessCrisis 给的就是首现序，这里不再排序。 */
export function crisisTermsHash(matched: readonly string[]): string {
  return createHash('sha256').update(matched.join('|')).digest('hex');
}

/**
 * 记一次危机命中。**两条通路共用这一个函数**（见文件头）。
 *
 * @param caseId 无案调用时传 null——一个还没建档的人也可能正处在那一刻，
 *               那一行仍要记下来（它服务的是审计与用量，不是只服务某个案子的首行标记）。
 */
export function recordCrisisHit(
  db: Database,
  input: {
    userId: number;
    caseId: number | null;
    source: CrisisHitSource;
    /** assessCrisis 回的 matched（去重、首现序） */
    matched: readonly string[];
  },
): { id: number; termsHash: string } {
  const termsHash = crisisTermsHash(input.matched);
  // at 交给列 DEFAULT (datetime('now'))，不从 JS 落串（ADR-002）
  const id = Number(
    db
      .prepare('INSERT INTO crisis_hits (case_id, user_id, source, terms_hash) VALUES (?,?,?,?)')
      .run(input.caseId, input.userId, input.source, termsHash).lastInsertRowid,
  );
  return { id, termsHash };
}

/** 本案窗口内的命中次数。窗口边界是**闭区间的下沿**：正好 72 小时前那一条仍算在内。 */
export function countRecentCrisisHits(
  db: Database,
  caseId: number,
  now: Date = new Date(),
): number {
  const since = toSql(new Date(now.getTime() - WINDOW_MS));
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM crisis_hits WHERE case_id=? AND at >= ?')
    .get(caseId, since) as { n: number };
  return row.n;
}

/**
 * 事实卡首行的那一格。0 次回 null——**没有这一格，就是这段时间没有信号**。
 * 写成「近 72 小时无危机信号」的形态是：常驻的"正常"提示会被当成模板噪音跳过去，
 * 于是真有信号那次也一起被跳过去了（同 buildFactsStatusLine 抬头的理由）。
 */
export function crisisStatusMark(count: number): string | null {
  if (count <= 0) return null;
  return `近 ${CRISIS_HIT_WINDOW_HOURS} 小时有危机信号（${count} 次）`;
}
