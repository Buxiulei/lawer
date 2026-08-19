// app/src/lib/billing/estimate.ts
// 公道值预检：任务发起前估算本次预计消耗，把服务端 gate 从「余额 ≥ 1」升为「余额 ≥ 预计消耗」。
// 余额不够就在发起前拦下并给出缺口，不让用户跑到一半被掐。
//
// 数据源：gongdao_ledger 该 feature 的「消耗」流水（feature 精确匹配，非 ref 前缀——feature 由
//   gongdaoSettle 精确写入，一次索引即中；ref 前缀需 LIKE 全表扫且有撞键风险）。
// 主口径 P90（最近 RECENT_N 笔，向上取整到十位）；样本 < MIN_SAMPLE 回落静态种子。
import type Database from 'better-sqlite3';
import { getGongdao } from './index';
import { GONGDAO_LEDGER_TYPE } from './pricing';

/** 一次任务的预计公道值消耗。 */
export interface GongdaoEstimate {
  /** 预计消耗（整数公道值，十位取整）。 */
  gongdao: number;
  /** 依据：历史 P90 / 冷启动种子（定额端点也记 seed）。 */
  basis: 'history' | 'seed';
  /** 参与统计的历史样本数（种子档为实际样本数，可 < MIN_SAMPLE）。 */
  sampleN: number;
}

/** < MIN_SAMPLE 笔消耗视为冷启动，回落种子。 */
const MIN_SAMPLE = 8;
/** 取最近 RECENT_N 笔消耗算 P90。 */
const RECENT_N = 50;

/**
 * 冷启动静态种子（公道值/次）——`sampleN < MIN_SAMPLE` 时用；P90 就绪后自动被历史取代。
 * 键即 gongdaoSettle 写入的 feature 字符串（一一对应，无映射层）。
 * 全部草案值，待 M3 接入真实模型后按实测消耗核定。
 */
export const SEED: Record<string, number> = {
  intake: 300,     // 问诊（首诊一轮，含追问）
  companion: 200,  // 陪跑（单轮对话）
  draft: 400,      // 文书起草（一份初稿）
  ocr: 100,        // 文件解读（一份公司来函）
  asr: 300,        // 录音分析（一段录音转写 + 摘要）
  knowledge: 50,   // 知识检索（一次向量召回）
};

/** 未登记 feature 兜底种子（保守中位，防漏配即放行透支）。 */
export const SEED_DEFAULT = 300;

/**
 * 定额端点价目（spec §9：固化出证/导出/短信收定额）：`estimateGongdao` 命中即返回定额、不走 P90。
 * 这些端点成本主要在三方服务费而非 token，历史 P90 对它们没有意义。
 * 全部草案值，待 M3 核定。
 */
export const FIXED_PRICING: Record<string, number> = {
  attest: 2000, // 证据固化（可信时间戳 + 出证书）
  export: 1000, // 材料导出（一次含 PDF + Word）
};

/** 允许估算的 feature 白名单（= 八个扣费端点的 settle feature 键），供 GET 接口防注入。 */
export const KNOWN_ESTIMATE_FEATURES: readonly string[] = [
  'intake',
  'companion',
  'draft',
  'ocr',
  'asr',
  'attest',
  'export',
  'knowledge',
];

/** 向上取整到十位（安全边际 + 展示整齐，如「约 300 公道值」）。 */
const ceilTo10 = (n: number): number => Math.ceil(n / 10) * 10;

/**
 * 估算某 feature 一次任务的预计公道值消耗。
 * 主口径 P90（最近 RECENT_N 笔消耗，向上取整到十位）；样本 < MIN_SAMPLE 回落种子。
 */
export function estimateGongdao(db: Database.Database, feature: string): GongdaoEstimate {
  // 1) 定额端点直接返回定额，不走 P90。
  const fixed = FIXED_PRICING[feature];
  if (fixed != null) return { gongdao: fixed, basis: 'seed', sampleN: 0 };

  // 2) 最近 RECENT_N 笔该 feature 消耗额（正数 = -delta；delta<0 排除 cost=0 的零成本/幂等标记行）。
  const rows = db
    .prepare(
      `SELECT -delta AS amount FROM gongdao_ledger
         WHERE type = ? AND feature = ? AND delta < 0
         ORDER BY id DESC LIMIT ?`,
    )
    .all(GONGDAO_LEDGER_TYPE.consume, feature, RECENT_N) as { amount: number }[];

  // 3) 样本不足 → 种子。
  if (rows.length < MIN_SAMPLE) {
    return { gongdao: SEED[feature] ?? SEED_DEFAULT, basis: 'seed', sampleN: rows.length };
  }

  // 4) P90（升序取 ceil(0.9*(n-1)) 位）→ 十位取整。
  const sorted = rows.map((r) => r.amount).sort((a, b) => a - b);
  const p90 = sorted[Math.ceil(0.9 * (sorted.length - 1))];
  return { gongdao: ceilTo10(p90), basis: 'history', sampleN: rows.length };
}

/** gate 判定结果（余额 ≥ 预计 → ok；否则含 shortfall 缺口）。 */
export type GongdaoGateResult =
  | { ok: true; estimate: number; balance: number }
  | { ok: false; estimate: number; balance: number; shortfall: number };

/**
 * 服务端公道值 gate：把「余额 ≥ 1」升为「余额 ≥ 预计消耗」。
 * 按实结算仍在 settle 侧——估过 / 估不足都由下次 gate 收敛。
 */
export function ensureGongdaoFor(
  db: Database.Database,
  userId: number,
  feature: string,
): GongdaoGateResult {
  const { gongdao: estimate } = estimateGongdao(db, feature);
  const balance = getGongdao(userId, db);
  if (balance >= estimate) return { ok: true, estimate, balance };
  return { ok: false, estimate, balance, shortfall: estimate - balance };
}
