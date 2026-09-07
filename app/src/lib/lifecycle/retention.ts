// app/src/lib/lifecycle/retention.ts
// 保留期这一个数，以及由它派生的两句话。**只有这一份**：删除回包里承诺的天数、
// 注销回包里承诺的天数、清理任务真正据以到期的天数，三处必须是同一个数。
// 各写一遍的形态是——页面上写着 30 天，任务按 60 天跑，而两边都不报错。
//
// 依据：用户服务协议 v0.2 第五条第 8 款「你删除档案或注销账号后，证据文件、对话、
// 情绪与危机记录在 30 日内彻底删除」。

/** 软删到硬删之间的保留天数。 */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留期的毫秒数（清理任务算 cutoff 用）。 */
export const RETENTION_MS = RETENTION_DAYS * DAY_MS;

/** 从某一刻起算，什么时候会被真正删掉。 */
export function purgeAfter(from: Date): Date {
  return new Date(from.getTime() + RETENTION_MS);
}

/** 到这一刻为止、已经过了保留期的那些行的判定边界（canonical 串可直接字符串比较）。 */
export function purgeCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_MS);
}
