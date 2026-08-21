/**
 * 演示案件（/case/demo）的日期锚点。
 *
 * demo 是给未注册访客看的样板案件，日期一旦写死，上线后时间线会越拖越旧、
 * 待办期限会一条条变成「已逾期」。所以这里的做法是：所有 mock 日期都以「今天」
 * 为原点、按偏移量现算，任何时候打开演示案件，相对顺序不变、期限都还在跑。
 *
 * 三点前提说清楚：
 *
 * 1. 锚点在**模块加载时取一次**。server 与 client 各算一次，同一天内两边算出来
 *    是同一个值，所以水合不会对不上；只有恰好跨零点的那一瞬间两边可能差一天，
 *    演示数据上这点误差可以接受，不值得为它引入 context 传时钟的复杂度。
 *
 * 2. 时区**固定 +08:00**（Asia/Shanghai，无夏令时）。服务器部署在哪个时区都要跟
 *    北京口径一致，否则整套数据会整体偏一天。因此下面全部用 UTC 毫秒运算 +
 *    getUTC* 取值，绝不碰本地时区的 getMonth / getDate。
 *
 * 3. 本模块**只服务 demo 假数据**。接了真接口之后随 _mock 目录一起废弃，
 *    不要在业务代码里引用它。
 */

const DAY_MS = 86_400_000;
/** 北京时间相对 UTC 的固定偏移 */
const TZ_OFFSET_MS = 8 * 3_600_000;

/**
 * 锚点：把「北京时间的今天」搬到 UTC 零点上。
 * 之后所有取值走 getUTC*，等价于按 +08:00 的日历读数，与服务器本地时区无关。
 */
const ANCHOR_MS = Math.floor((Date.now() + TZ_OFFSET_MS) / DAY_MS) * DAY_MS;

const anchorDate = new Date(ANCHOR_MS);
const ANCHOR_YEAR = anchorDate.getUTCFullYear();
/** 自公元 0 年起的自然月序号，用来做不受 30 天近似影响的整月加减 */
const ANCHOR_MONTH_INDEX = ANCHOR_YEAR * 12 + anchorDate.getUTCMonth();

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymdOf(dayOffset: number): Ymd {
  const d = new Date(ANCHOR_MS + dayOffset * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function ymOf(monthOffset: number): { y: number; m: number } {
  const index = ANCHOR_MONTH_INDEX + monthOffset;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

/* ── 按天偏移 ─────────────────────────────────────────────────── */

/** 带时区偏移量的 ISO 串，如 demoDay(0, '23:59') → 2026-08-22T23:59:00+08:00。 */
export function demoDay(dayOffset: number, timeOfDay = '00:00'): string {
  const withSeconds = timeOfDay.length === 5 ? `${timeOfDay}:00` : timeOfDay;
  return `${demoDate(dayOffset)}T${withSeconds}+08:00`;
}

/** 2026-08-22 */
export function demoDate(dayOffset: number): string {
  const { y, m, d } = ymdOf(dayOffset);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 2026 年 8 月 22 日（数字与汉字之间留空格，全站排版规范） */
export function demoCnDate(dayOffset: number): string {
  const { y, m, d } = ymdOf(dayOffset);
  return `${y} 年 ${m} 月 ${d} 日`;
}

/** 8 月 22 日；正文里年份已由上下文交代时用这一版，避免每句都带年 */
export function demoShortCnDate(dayOffset: number): string {
  const { m, d } = ymdOf(dayOffset);
  return `${m} 月 ${d} 日`;
}

/** 该日是几号（发薪日这类「每月第几天」的口径要跟着锚点走） */
export function demoDayOfMonth(dayOffset: number): number {
  return ymdOf(dayOffset).d;
}

/** 该日属于哪一年（入职年份、工号里的年份） */
export function demoYearOfDay(dayOffset: number): number {
  return ymdOf(dayOffset).y;
}

/** 该日落在哪个自然月，返回相对本月的月偏移量，供 demoMonth* 系列复用 */
export function demoMonthOfDay(dayOffset: number): number {
  const { y, m } = ymdOf(dayOffset);
  return y * 12 + (m - 1) - ANCHOR_MONTH_INDEX;
}

/* ── 按自然月 / 年偏移 ────────────────────────────────────────── */

/** 2026-08 */
export function demoMonth(monthOffset: number): string {
  const { y, m } = ymOf(monthOffset);
  return `${y}-${pad2(m)}`;
}

/** 2026 年 8 月 */
export function demoMonthCn(monthOffset: number): string {
  const { y, m } = ymOf(monthOffset);
  return `${y} 年 ${m} 月`;
}

/** 8 月 */
export function demoShortMonthCn(monthOffset: number): string {
  return `${ymOf(monthOffset).m} 月`;
}

/** 月份区间：同年省略后一个年份（2026 年 3 月至 6 月），跨年补全（2025 年 8 月至 2026 年 6 月） */
export function demoMonthRangeCn(fromOffset: number, toOffset: number): string {
  const from = ymOf(fromOffset);
  const to = ymOf(toOffset);
  const tail = from.y === to.y ? `${to.m} 月` : `${to.y} 年 ${to.m} 月`;
  return `${from.y} 年 ${from.m} 月至 ${tail}`;
}

/** 2026 */
export function demoYear(yearOffset: number): number {
  return ANCHOR_YEAR + yearOffset;
}

/**
 * 把一个日偏移按**自然月**平移，返回新的日偏移（入职日、合同到期日这类「几年前同月同日」）。
 * 月末溢出向前收：3 月 31 日减 1 个月得 2 月 28/29 日，而不是滚进 3 月。
 */
export function demoShiftMonths(dayOffset: number, monthOffset: number): number {
  const { y, m, d } = ymdOf(dayOffset);
  const index = y * 12 + (m - 1) + monthOffset;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const target = Date.UTC(targetYear, targetMonth, Math.min(d, lastDay));
  return Math.round((target - ANCHOR_MS) / DAY_MS);
}
