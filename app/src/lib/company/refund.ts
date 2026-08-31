// app/src/lib/company/refund.ts
// 公司档案的分模块退款。**这是「数据诚实红线」绑到钱上的那一环**：拆包后每个付费模块都等比例接红线，
// 触发即把该模块的钱退回去，其余模块与已交付的明细照留。
//
//   M3 关联谱系   ：高置信关系边 < 门槛 → 全退（低置信节点与边保留可看，只是不作数）
//   M5 涉诉深度统计：可判定结果篇数 < 门槛 / 超 SLA 未交付 → 全退（逐篇结构化明细保留可查）
//   M6 HR套路归纳 ：保留 pattern 条目 < 门槛（含"全部被丢=0"）→ 全退（dropped 计数后台可查）
//
// 一条没有退款绑定的诚实红线，在压力下一定会被改成一句小字——所以门槛判定归统计层，
// 触发归巡检 job，而**退这一步长在这里、有幂等、有测试**，三者缺一它就退回成文案。
//
// 退多少不重算价：一律取账本里那一笔消耗的实际金额（gongdao_ledger 是唯一事实源）。
// 重算的话，中途调过价就会退错——退多了是我们的钱，退少了是用户的钱，两个方向都不能接受。
// 券覆盖 / 免费的模块只落 delta=0 标记行，listModuleCharges 只认 delta<0 的真实扣费，故它们退 0
// （那单本来就没花钱，券也不追回——券已兑现成一次核心建档）。
import type Database from 'better-sqlite3';

import { gongdaoRefund } from '../billing/index';
import { GONGDAO_LEDGER_TYPE } from '../billing/pricing';
import { readPrice } from '../billing/pricing-config';
import {
  DOSSIER_MODULE_FEATURE,
  DOSSIER_MODULE_LABEL,
  type DossierModule,
} from './dossier-billing';

/** 退款事由。只用于回给调用方（巡检 job）去写 job_runs / notify_log，本模块不自己发通知。 */
export type DossierRefundReason =
  | 'sample_insufficient'
  | 'sla_expired'
  | 'graph_low_confidence'
  | 'patterns_insufficient';

/** 事由 → 给用户看的中文说明（通知文案由通知层按中性/详细模式再决定露不露）。 */
export const DOSSIER_REFUND_REASON_TEXT: Record<DossierRefundReason, string> = {
  sample_insufficient: '可判定结果的文书篇数不足门槛，本模块不出统计结论，费用已全额退回；逐篇结构化明细保留可查',
  sla_expired: '文书取证超过承诺期限仍未交付，费用已全额退回；已入档的其它模块不退不删',
  graph_low_confidence: '高置信关系边不足门槛，图谱不作数，费用已全额退回；已画出的低置信节点与边保留可看',
  patterns_insufficient: '可用套路条目不足门槛，本模块费用已全额退回；被丢弃条目计数后台可查',
};

export interface DossierRefundLine {
  userId: number;
  chargeRef: string;
  /** 该笔消耗的实际金额（公道值）。 */
  amount: number;
  /** true=本次真退了；false=此前已退过（幂等命中），余额未再变动。 */
  refunded: boolean;
}

export interface DossierRefundResult {
  dossierId: number;
  module: DossierModule;
  reason: DossierRefundReason;
  lines: DossierRefundLine[];
  /** 本次真实退回的公道值合计（不含幂等命中的那些）。 */
  totalRefunded: number;
}

/**
 * 列出某条档案某一模块的全部**真实扣费**流水（可能不止一位付款人：档案是公司维度共享资产）。
 *
 * `delta < 0` 有意排除券覆盖/免费的 delta=0 标记行——那些本来就没花钱，不该退。
 * 用 LIKE 前缀匹配是有意的：幂等键 `dossier-<id>-u<uid>-<模块>` 里的用户 id 事先不知道。
 * WHERE 先按 feature 走部分索引（只覆盖消耗类），LIKE 只在该 feature 的行里过一遍，不是全表扫；
 * 撞键也不可能：`dossier-1-u` 与 `dossier-12-u...` 在第二个 `-` 处就分开了。
 */
export function listModuleCharges(
  db: Database.Database,
  dossierId: number,
  module: DossierModule,
): { userId: number; amount: number; chargeRef: string }[] {
  return db
    .prepare(
      `SELECT user_id AS userId, -delta AS amount, ref_id AS chargeRef
         FROM gongdao_ledger
        WHERE type=? AND feature=? AND delta < 0 AND ref_id LIKE ?
        ORDER BY id ASC`,
    )
    .all(
      GONGDAO_LEDGER_TYPE.consume,
      DOSSIER_MODULE_FEATURE[module],
      `dossier-${dossierId}-u%-${module}`,
    ) as { userId: number; amount: number; chargeRef: string }[];
}

/**
 * 退某条档案的某一模块，退给该模块的每一位付款人。
 *
 * 幂等：gongdaoRefund 自己按 `refund-<chargeRef>` 去重，同一条重放只退一次（返回 refunded=false，
 * 余额不动）。所以巡检 job 每轮无脑调用是安全的——「这轮到底退没退过」不需要 job 自己记，问账本就行。
 */
export function refundDossierModule(
  db: Database.Database,
  dossierId: number,
  module: DossierModule,
  reason: DossierRefundReason,
): DossierRefundResult {
  const feature = DOSSIER_MODULE_FEATURE[module];
  const lines: DossierRefundLine[] = [];
  let totalRefunded = 0;

  for (const charge of listModuleCharges(db, dossierId, module)) {
    const refunded = gongdaoRefund(charge.userId, charge.amount, charge.chargeRef, feature, db);
    if (refunded) totalRefunded += charge.amount;
    lines.push({ userId: charge.userId, chargeRef: charge.chargeRef, amount: charge.amount, refunded });
  }

  return { dossierId, module, reason, lines, totalRefunded };
}

/**
 * M5「样本不足退涉诉深度统计」。判据（可判定结果篇数）由统计层给，门槛读 pricing_config；
 * 本函数只负责「不足就退」，不重新解释什么叫不足——门槛与篇数各只有一个来源。
 * @returns 未触发（篇数达标）时返回 null，调用方据此区分「够，没退」与「不够，退了」。
 */
export function refundDocsStatsIfSampleShort(
  db: Database.Database,
  dossierId: number,
  outcomeDecidedCount: number,
): DossierRefundResult | null {
  if (outcomeDecidedCount >= readPrice(db, 'dossier.min_sample_outcome')) return null;
  return refundDossierModule(db, dossierId, 'docs_stats', 'sample_insufficient');
}

/** M5「超 SLA 未交付退涉诉深度统计」。是否超期由巡检 job 按 litigation_sla_days 判，本函数只执行退。 */
export function refundDocsStatsSlaExpired(db: Database.Database, dossierId: number): DossierRefundResult {
  return refundDossierModule(db, dossierId, 'docs_stats', 'sla_expired');
}

/**
 * M3「高置信关系边不足退关联谱系」（§4.5-C，与 M5/M6 同一条红线、同一把尺子）。
 * 图谱的"样本"就是高置信关系边：交付后低于门槛全额退，退款保留低置信明细。
 * @returns 未触发（边数达标）时返回 null。
 */
export function refundGraphIfLowConfidence(
  db: Database.Database,
  dossierId: number,
  highConfEdgeCount: number,
): DossierRefundResult | null {
  if (highConfEdgeCount >= readPrice(db, 'dossier.min_graph_high_conf_edges')) return null;
  return refundDossierModule(db, dossierId, 'graph', 'graph_low_confidence');
}

/**
 * M6「保留 pattern 不足退 HR 套路归纳」（§4.5-D，含"全部被丢=0"，与 M5 样本门槛对称）。
 * @returns 未触发（保留条目达标）时返回 null。
 */
export function refundPatternsIfKeptShort(
  db: Database.Database,
  dossierId: number,
  patternsKeptCount: number,
): DossierRefundResult | null {
  if (patternsKeptCount >= readPrice(db, 'dossier.min_patterns_kept')) return null;
  return refundDossierModule(db, dossierId, 'patterns', 'patterns_insufficient');
}

/** 退款说明（一句人话，给通知层与后台账单页用；不含公司名，露不露由通知层决定）。 */
export function refundNote(result: DossierRefundResult): string {
  return `${DOSSIER_MODULE_LABEL[result.module]}：${DOSSIER_REFUND_REASON_TEXT[result.reason]}（共 ${result.totalRefunded} 公道值）`;
}
