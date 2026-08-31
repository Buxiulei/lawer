// app/src/lib/billing/pricing-config.ts
// pricing_config 表的**唯一读入口**：定额报价、样本门槛、SLA 天数、缓存 TTL 全走这里。
//
// 【为什么要有这张表 / 这个函数】改价改门槛不该改代码。代码常量从「事实源」退成「兜底」：
// 表里有行就以表为准，缺行才回落常量。于是「线上现在按多少收」是一个可以查、可以改、
// 可以留 note 说明为什么改的东西，而不是一次发版。
//
// 【为什么是 readConfigInt 而不是 readPrice】本表存的不只是价：`dossier.min_sample_outcome`
// 是篇数、`dossier.litigation_sla_days` 是天数、`dossier.ttl_graph_days` 是天数。
// 叫它 readPrice 会让下一个人以为门槛不该放这儿，于是另起一张表——那才是真的分叉。
// 计费侧要一个带 FIXED_PRICING 兜底的 readPrice(db, key)，在本函数上包一层即可，
// **不要另写一个直连 pricing_config 的读法**：一张表两个读入口，改一处忘一处。
//
// 【兜底必须由调用方显式给】不设「全局默认表」：那会让「这个键没配」与「这个键配成了默认值」
// 在读侧长得一模一样，而前者是配置漏了、后者是有人特意设成这个数。
import type { Database } from 'better-sqlite3';

/** 本仓用到的键（值集与 docs 同步；TEXT 主键不加 CHECK，值集由本层把关）。 */
export type PricingConfigKey =
  | 'dossier.graph'
  | 'dossier.litigation'
  | 'dossier.cached'
  | 'watch.tier.daily'
  | 'watch.tier.weekly'
  | 'watch.tier.archive'
  | 'dossier.min_sample_outcome'
  | 'dossier.min_sample_duration'
  | 'dossier.litigation_sla_days'
  | 'dossier.ttl_graph_days'
  | 'dossier.ttl_litigation_days';

/**
 * 读一个整数配置：表里有行取表，缺行取 fallback。**每次调用都查库**——
 * 不做进程内缓存：改表要立刻生效，不能要求重启（重启才生效的配置等于没有配置）。
 *
 * 表里存了非整数（被人手工写脏）时当场抛错，不静默取整：一个被悄悄截断的门槛
 * 会让「样本不足不出数」这条红线在某个边界上安静失效。
 */
export function readConfigInt(
  db: Database,
  key: PricingConfigKey | string,
  fallback: number,
): number {
  const row = db.prepare('SELECT value_int FROM pricing_config WHERE key = ?').get(key) as
    | { value_int: number }
    | undefined;
  if (!row) return fallback;
  if (!Number.isInteger(row.value_int)) {
    throw new Error(
      `pricing_config 的 ${key} 不是整数（读到 ${JSON.stringify(row.value_int)}）：` +
        '本表只存整数（公道值 / 篇数 / 天数），非整数多半是人工改表时写错了列；' +
        `请把该行改成整数，或删掉该行让它回落代码常量（${fallback}）。`,
    );
  }
  return row.value_int;
}
