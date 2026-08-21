import type { GraphTier } from '@/app/_mock/company-graph';

/** 关系语义分三档，线型跟着它走 */
export type EdgeKind = 'equity' | 'control' | 'brand';

export const EDGE_DASH: Record<EdgeKind, string | undefined> = {
  equity: undefined, // 股权是硬关系：实线
  control: '7 5', // 同法代/实控是推定关系：虚线
  brand: '2 5', // 只有品牌或分支痕迹：点线
};

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  equity: '股权/持股',
  control: '同法代/实控',
  brand: '品牌/分支关联',
};

/**
 * relation 原文 → 语义档。
 *
 * 只拿括号前的关系名判类：括号里写的是限定与否证——「同一实控体系(非直接股权，
 * 平行主体)」「同属同一品牌矩阵(无股权链一手证据)」里那两个"股权"都是在**否认**
 * 股权，按关键词扫全串会把它们错判成股权边（实线+箭头，看上去像有持股关系）。
 * 实控/法代先于持股判，关系名同时带两者时以控制关系为准。
 */
export function edgeKind(relation: string): EdgeKind {
  const head = relation.split(/[(（]/)[0];
  if (/实控|法定代表人/.test(head)) return 'control';
  if (/持股|股权/.test(head)) return 'equity';
  return 'brand';
}

export const EDGE_WIDTH = 1.4;
/** 发薪链（签约壳↔用工主体）加粗，一眼能从别的关系里挑出来 */
export const PAYROLL_CHAIN_WIDTH = 2.6;
/** 只有 confidence=低 的边淡化，中/高一律不淡——淡化是"证据不足"的信号 */
export const LOW_CONFIDENCE_OPACITY = 0.45;

/** 只有股权边画箭头：箭头在这张图上表示「谁持有谁」，别的关系没有方向 */
export function hasArrow(relation: string): boolean {
  return edgeKind(relation) === 'equity';
}

/** 圈层色环：环是描边不是填充，2px，红色只落在圈1这一圈上 */
export const TIER_RING: Record<GraphTier, string> = {
  1: 'border-danger',
  2: 'border-amber',
  3: 'border-line',
};
