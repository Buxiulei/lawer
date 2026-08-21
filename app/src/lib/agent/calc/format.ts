// app/src/lib/agent/calc/format.ts
// 金额展示（第一批 jingji-buchang.ts 原地抽出，两批公式共用，行为零变化）。

/** 分 → 「1,234.56」。手写而非 toLocaleString，避免不同环境 ICU 数据差异导致算式串漂移。 */
export function yuan(fen: number): string {
  const fixed = (fen / 100).toFixed(2);
  const negative = fixed.startsWith('-');
  const [intPart, decPart] = (negative ? fixed.slice(1) : fixed).split('.');
  return `${negative ? '-' : ''}${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decPart}`;
}

/** 天数展示：整数不带小数，折算值保留 4 位（年假 181÷365×5 这类算式要看得见余数）。 */
export const days = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
