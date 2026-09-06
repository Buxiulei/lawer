// app/src/lib/cases/report-stale.ts
// 个案报告的**过期唯一入口**（设计稿 §4.3）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 lib/capabilities/registry.ts 抬头）。触发原因那几个词
// 由**调用侧**给（各自那个写入口最清楚自己改了什么），本文件只负责累加与落库。
// ─────────────────────────────────────────────────────
//
// 【为什么单独一个文件而不并进 report.ts】调它的是最底层的写函数（lib/db/agent.ts、
// lib/db/cases.ts 之上的领域写入口、后台任务），而 report.ts 要读那六张表来生成初稿。
// 并在一起就是 db 层 ⇄ 报告层的循环依赖：跑得通，但依赖图上多一个环，
// 而环断掉的那天报错会出现在一个跟报告毫无关系的模块里。这里只依赖 Database 类型。
//
// 【为什么是"唯一入口"】"改了档案要把报告标过期"这件事独立写 N 次就会忘 N 次，
// 忘掉之后的形态是：报告仍然显示"最后更新于三天前"、看起来很正常，
// 而这三天里新加的两份证据它一个字都不知道。所以只有这一个函数会写 stale_*。
import type { Database } from 'better-sqlite3';

/** stale_reason 里的计数表：触发原因 → 这一轮过期期间该原因发生了几次。 */
export type StaleTally = Record<string, number>;

/** 报告"多久没整理就算过期"的天数（设计稿 §4.3）。 */
export const REPORT_IDLE_STALE_DAYS = 7;

/** 7 天未整理这一档的固定说明。它不是某次写入的原因，所以不进计数表。 */
export const REPORT_IDLE_REASON = `超过 ${REPORT_IDLE_STALE_DAYS} 天未整理`;

interface StaleRow {
  stale_since: string | null;
  stale_reason: string | null;
}

/**
 * 解析计数表。**容得下三种历史形态**：null（没过期）、JSON 计数表（当前格式）、
 * 一句话（万一将来有人手改过库）。解不出来的一律当作"有 1 条说不清来源的变动"，
 * 不当成"没有变动"——把读不懂的东西按"什么都没发生"处理，正是首行状态区最不该犯的错。
 */
export function parseStaleTally(raw: string | null): StaleTally {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: StaleTally = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n > 0) out[k] = Math.trunc(n);
      }
      return out;
    }
  } catch {
    // 落到下面按整串当一条原因
  }
  return { [raw]: 1 };
}

/** 计数表 → 「新证据 2、时间线 1」。顺序按计数降序，同数按原因字面稳定排。 */
export function formatStaleTally(tally: StaleTally): string {
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ${n}`)
    .join('、');
}

/** 计数表里一共几条变动 */
export function countStaleTally(tally: StaleTally): number {
  return Object.values(tally).reduce((n, v) => n + v, 0);
}

/**
 * 把一个案件的报告标记为过期，并把本次原因计一笔。
 *
 * @param reason 触发原因，由调用侧给（「新证据」「时间线」「期限」……）。
 *
 * 【stale_since 只在第一次设】它答的是「从什么时候起报告跟档案对不上」，
 * 每次触发都刷新的话，攒了九天的九条变动会显示成「自今天起 9 条变动」——
 * 而"今天刚变的"与"九天前就开始变了"对"要不要先整理"是两个答案。
 *
 * 【案件不存在时什么都不做】本函数挂在最底层的写路径上，
 * 让一次外键错误从这里抛出去，等于让"记不了报告过期"把用户那次真正的写入也一起弄失败。
 */
export function markReportStale(db: Database, caseId: number, reason: string): void {
  const label = reason.trim();
  if (!Number.isInteger(caseId) || caseId <= 0 || !label) return;

  const row = db
    .prepare('SELECT stale_since, stale_reason FROM case_reports WHERE case_id = ?')
    .get(caseId) as StaleRow | undefined;

  if (!row) {
    const known = db.prepare('SELECT 1 FROM cases WHERE id = ?').get(caseId);
    if (!known) return;
    // 还没有报告也要留下这一笔：等用户第一次打开报告时，bootstrap 会把这些变动一并吃进初稿。
    // 占位行的 version=0，所以它不会被误当成"已有初稿"。
    db.prepare(
      `INSERT INTO case_reports (case_id, sections_json, rendered_md, version, stale_since, stale_reason)
       VALUES (?, '{}', '', 0, datetime('now'), ?)`,
    ).run(caseId, JSON.stringify({ [label]: 1 }));
    return;
  }

  const tally = row.stale_since ? parseStaleTally(row.stale_reason) : {};
  tally[label] = (tally[label] ?? 0) + 1;
  db.prepare(
    `UPDATE case_reports
        SET stale_since = COALESCE(stale_since, datetime('now')), stale_reason = ?
      WHERE case_id = ?`,
  ).run(JSON.stringify(tally), caseId);
}
