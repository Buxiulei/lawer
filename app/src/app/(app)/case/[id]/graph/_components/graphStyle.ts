import type { GraphTier } from '@/app/_mock/company-graph';

/**
 * relation 原文 → 线型。语义分三档：股权是硬关系（实线带箭头指向被持股方）、
 * 人事/实控是推定关系（虚线）、只有品牌或分支痕迹的是弱关系（点线）。
 */
export function edgeDash(relation: string): string | undefined {
  if (/持股|股权/.test(relation)) return undefined;
  if (/法定代表人|实控/.test(relation)) return '7 5';
  return '2 5';
}

/** 只有股权边画箭头：箭头在这张图上表示「谁持有谁」，别的关系没有方向 */
export function hasArrow(relation: string): boolean {
  return /持股|股权/.test(relation);
}

/** 圈层色环：环是描边不是填充，2px，红色只落在圈1这一圈上 */
export const TIER_RING: Record<GraphTier, string> = {
  1: 'border-danger',
  2: 'border-amber',
  3: 'border-line',
};
