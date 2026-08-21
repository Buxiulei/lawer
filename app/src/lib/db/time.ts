// app/src/lib/db/time.ts
// 全项目 canonical 时间格式的唯一生成入口（ADR-002）。
//
// canonical = SQLite datetime('now') 的产出格式：UTC、空格分隔、秒精度、无毫秒无时区后缀，
// 即 'YYYY-MM-DD HH:MM:SS'。DDL 默认值用的就是它，应用层写时间列必须与之同格式。
//
// 为什么不许直接 toISOString()：它产出 '2026-08-19T00:00:00.000Z'，与 canonical 串混存后
// 裸字符串比较会排序错乱——'T'(0x54) > ' '(0x20)，于是同一天的 ISO 串恒排在全部 canonical
// 串之后。这条曾构成 OTP 冷却绕过路径（ADR-002 背景）。canonical 串之间可直接字符串比较，
// 这正是它值钱的地方，混进一个 ISO 串就全废。
//
// 边界：API 入参的 ISO8601 在路由层转成 Date 再经 toSql() 落库；
// 来源不明的存量串在 SQL 侧用 datetime() 归一后再比。
// 精度：秒。需要更细的先后顺序请用 id（AUTOINCREMENT），不要往时间串上加毫秒。

/** 把 Date 转成 canonical 串（UTC，秒精度，毫秒直接截断而非四舍五入——与 SQLite 一致）。 */
export function toSql(date: Date): string {
  // toISOString 恒为 UTC 且格式固定，取前 19 字符即 'YYYY-MM-DDTHH:MM:SS'，再把 T 换成空格。
  // 非法 Date 会在此抛 RangeError——这是刻意的，宁可炸也不要往库里写 'Invalid Date'。
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 当前时刻的 canonical 串，等价于 SQL 里的 datetime('now')。 */
export function nowSql(): string {
  return toSql(new Date());
}

/**
 * 把库里读出的 canonical 串解析回 Date（toSql 的逆函数）。**只吃 canonical 串**。
 * 直接 `new Date('YYYY-MM-DD HH:MM:SS')` 是陷阱：无时区标记按**本地时区**解析，
 * 在 +08:00 机器上整体漂移 8 小时。canonical 恒为 UTC，必须补 'T'+'Z' 再解析。
 *
 * 喂 ISO8601 会直接 throw（manager 2026-08-19 裁决，fail loud）：ISO 串对
 * `.replace(' ','T')` 是空操作、尾部再补 'Z' 得双 Z → Invalid Date 静默传播，
 * 比抛错危险得多。API 入参的 ISO8601 请在路由层自行转换，不要复用本函数。
 */
export function fromSql(value: string): Date {
  if (value.includes('T') || value.includes('Z')) {
    throw new Error(`fromSql 只接受 canonical 串（'YYYY-MM-DD HH:MM:SS'），收到：${value}`);
  }
  return new Date(value.replace(' ', 'T') + 'Z');
}
