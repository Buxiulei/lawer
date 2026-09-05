// app/src/lib/capabilities/shared.ts
// 各族能力共用的入参小工具与片段。从 lib/mcp/tools.ts 原样搬来，行为逐字不变。

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
