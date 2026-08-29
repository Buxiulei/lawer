/** 分 → 元，千分位 + 两位小数。展示时配 tabular-nums（.num）。 */
export function formatFen(fen: number): string {
  const negative = fen < 0;
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const withSeparator = yuan.toLocaleString('zh-CN');
  return `${negative ? '-' : ''}${withSeparator}.${String(cents).padStart(2, '0')}`;
}

/** 分 → 「44.37 万元」这类粗读量级，用于概览卡片。 */
export function formatFenCompact(fen: number): string {
  const yuan = fen / 100;
  if (Math.abs(yuan) >= 10000) return `${(yuan / 10000).toFixed(2)} 万元`;
  return `${yuan.toFixed(2)} 元`;
}

const DATE_TZ = 'Asia/Shanghai';

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * 只要月/日（`07/24`）。**给横向排得下八格的里程碑轨道用**——
 * 393 下每格约 45px，完整的 `2026/07/24` 放不下。
 * 年份不是丢了：宽屏渲染完整日期、`title` 里挂完整日期、档案里是原始记录。
 * **不做「同年省略年份」那种变格式**——那类规则出错时是静默的，宁要一致的短格式。
 */
export function formatMonthDay(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DATE_TZ,
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * 距离 due 还有几天（向上取整，今天到期算 0）。
 * 传入 now 以便服务端渲染与测试可控。
 */
export function daysUntil(dueIso: string, now: Date = new Date()): number {
  const due = new Date(dueIso).getTime();
  return Math.ceil((due - now.getTime()) / 86_400_000);
}

/** 倒计时文案：不用感叹号，给确定的数字。 */
export function formatCountdown(dueIso: string, now: Date = new Date()): string {
  const days = daysUntil(dueIso, now);
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  return `还剩 ${days} 天`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
