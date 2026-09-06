// app/src/lib/time/index.ts
// **对外时间的唯一格式化入口。** 库里存的是 ADR-002 的 canonical 串（UTC、空格分隔、秒精度、
// 无时区后缀）；对外一律输出带 +08:00 的 ISO 8601。存储不变，只改回显。
//
// 【它修的是什么】canonical 串对外发出去时**不带任何时区标记**。收到 `2026-09-06 16:30:00`
// 的一方（用户自己的 agent、浏览器、Excel）只能猜：多数会按本地时区解析。在 +08 的机器上
// 那一刻被读成北京 16:30，而它真正的北京时间是次日 00:30 —— 整整差了 8 小时、还跨了一天。
// 期限提醒、时间线排序、"这件事发生在哪天"全都会因此错一天，而且**没有任何一处会报错**。
//
// 【为什么用固定 +08:00 而不是 Intl 的 tz 换算】Asia/Shanghai 自 1991 年起不再有夏令时，
// 偏移恒为 +08:00；本项目的数据全是当代与将来的时刻。固定偏移是确定的、可逐字断言的，
// 而 Intl 的输出格式不在规范保证之列（同一个 locale 换个 Node 版本就可能换排版）。
// 与 lib/deadline/case-day 的 CASE_TZ 是同一个时区，两者对同一时刻给出同一个日历日。
//
// 【为什么是一个深度遍历而不是每个字段各写一遍】对外的时间字段有几十个、分散在几十个路由里。
// 独立写 N 次就会忘 N 次，而忘掉的那一处与"这个接口没有时间字段"在外部完全同形。
// 所以过滤收在出口：REST 走 lib/http/json 的 apiJson，MCP 走 lib/mcp/jsonrpc 的 toolTextResult，
// 事实卡走 toDisplayDay —— 三处同源，都调本文件。

/** 对外时区：北京时间。与 lib/deadline/case-day 的 CASE_TZ 同一个。 */
export const OUTBOUND_TZ = 'Asia/Shanghai';
/** 对外偏移串。Asia/Shanghai 自 1991 年起无夏令时，恒为 +08:00。 */
export const OUTBOUND_OFFSET = '+08:00';

const OFFSET_MS = 8 * 60 * 60 * 1000;

/** canonical 串的形状（ADR-002）：'YYYY-MM-DD HH:MM:SS'，无 T、无 Z、无偏移。 */
const CANONICAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function isCanonical(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL.test(value);
}

/**
 * canonical（UTC）→ 带 +08:00 的 ISO 8601。
 *
 * 不是 canonical 的串**原样返回**：来源可能是 TSA 给的 ISO、知识卡上的 'YYYY-MM-DD'、
 * 或演示数据里本来就带偏移的串。硬转会把一个已经正确的时间搞错，而这里没有把握说它错了。
 */
export function toDisplayTime<T extends string | null | undefined>(value: T): T {
  if (!isCanonical(value)) return value;
  const utcMs = new Date(`${value.replace(' ', 'T')}Z`).getTime();
  return `${new Date(utcMs + OFFSET_MS).toISOString().slice(0, 19)}${OUTBOUND_OFFSET}` as T;
}

/**
 * canonical（UTC）→ 该时刻落在**北京**的哪个日历日，'YYYY-MM-DD'。
 *
 * 【为什么不能直接切前 10 个字符】那是 UTC 日历日。北京 00:00–07:59 这段，UTC 还在前一天，
 * 于是"今天"在每天早上八点前都指着昨天。事实卡里的日期按这个函数取。
 */
export function toDisplayDay(value: string): string {
  const iso = toDisplayTime(value);
  return iso.slice(0, 10);
}

/** 哪些键算时间字段：全站对外字段名一律 snake_case，时间列一律以 _at / _time 结尾。 */
const TIME_KEY = /(_at|_time)$/;

export function isTimeKey(key: string): boolean {
  return TIME_KEY.test(key);
}

/** 深度遍历时的护栏：结构再深也不会把栈走穿（回包本就是浅结构，超了说明拿到了环）。 */
const MAX_DEPTH = 12;

/**
 * 深拷贝一份载荷，把**时间字段上的 canonical 串**换成带 +08:00 的 ISO。
 *
 * 只认「键名像时间 **且** 值是 canonical 形状」这一种组合：
 * · 键名不像时间的不动 —— 正文里恰好出现一个日期串，不该被改写；
 * · 值不是 canonical 的不动 —— 它已经带了时区，或压根不是时间。
 * 两条都不满足就一个字节都不碰，这让本函数对任何已有回包都是安全的。
 */
export function withDisplayTimes<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => withDisplayTimes(v, depth + 1)) as unknown as T;
  }
  // Date / Buffer 一类的对象不拆：它们不是回包里的数据结构，拆开会把它们变成 {} 。
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isTimeKey(k) && isCanonical(v) ? toDisplayTime(v) : withDisplayTimes(v, depth + 1);
  }
  return out as T;
}
