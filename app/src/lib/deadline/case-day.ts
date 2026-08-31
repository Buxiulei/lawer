// app/src/lib/deadline/case-day.ts
// 「还剩几天」的**唯一一把尺**（manager 2026-08-31 派：UI 与邮件此前各算各的）。
//
// 【为什么必须只有一把尺】同一条期限的倒计时同时出现在驾驶舱和提醒邮件里。
// 两处各写一个算法时，同一时刻会给出**不同的天数**，而且没有任何东西会报错——
// 用户看到的是「驾驶舱说还剩 1 天、邮件说今天到期」，他会挑听起来宽松的那个信。
// 期限错过即权利灭失，所以这把尺收在这里；两边 import 同一个函数，不许各自再写
// （案发现场：_ui/format.ts 的 Math.ceil(毫秒差/86400000) vs 本文件前身在 notify 里的日历日算法）。
//
// 【为什么锚在案件时区，不用浏览器/服务器本地时区】期限是在**北京**届满的：
// 朝阳仲裁委的窗口按北京时间关门，computeDeadline 算出的 dueDate 也是北京日历日。
// 若按浏览器本地时区算，一个在纽约（UTC-4）的用户在北京 9 月 10 日 08:00 时，
// 本地还是 9 月 9 日 20:00 —— 他会读到「还剩 1 天」，而这条期限**当天就届满了**。
// 那正是"让用户高估剩余时间"的方向，是这类错误里唯一不可接受的一种。
// 反方向（用户在更东的时区，读到比北京少一天）只会让他提前动手，无害。
// 所以：统一到案件时区，不做"客户端用用户本地时区"的语义差。
// 附带好处：同一张卡上的日期（formatDate 已按 Asia/Shanghai 渲染）与天数出自同一时区，
// 且 SSR 与 hydration 算出的是同一个数，不会出现水合不一致。
//
// 【为什么不用服务器/浏览器的 TZ 环境变量】那是**部署环境**的属性，不是**案件**的属性。
// 一台机器改了 TZ 就会让全站倒计时整体漂一天，而这个漂移是静默的。这里写死案件时区。

/** 案件时区：本项目只办北京朝阳的劳动争议，期限按北京日历日届满。 */
export const CASE_TZ = 'Asia/Shanghai';

// 模块级构造：Intl.DateTimeFormat 建一次比每次调用建便宜得多，且时区写死在这里，
// 不受 process.env.TZ / 浏览器设置影响。
const CASE_DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: CASE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 某一时刻落在案件时区的哪个日历日，'YYYY-MM-DD'。
 *
 * 【不用 toISOString().slice(0,10)】那给的是 **UTC** 日历日，在北京 00:00–07:59 这段
 * 恒比北京日期少一天。前身正是这么写的，于是「今天」在每天早上八点前都指的是昨天。
 * 【不用 en-CA 直接 format】locale 的输出格式不在规范保证之列，用 formatToParts 逐字段取。
 */
export function caseDayOf(at: Date): string {
  const parts: Record<string, string> = {};
  for (const p of CASE_DAY_FMT.formatToParts(at)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * 'YYYY-MM-DD…' 的**日期头** → 该日 UTC 零点的毫秒数，用作日历日相减的公共原点。
 *
 * 【为什么只看日期头，不解析整串】due_at 在库里是 `datetime(?)` 的产物
 * （`'2026-09-10 00:00:00'`，无时区标记），演示数据里是 `'2026-09-10T23:59:00+08:00'`，
 * 而 computeDeadline 的输出本来就只是一个**日期**。把时分秒/时区当真去解析，
 * 就会让"到期日"随存储格式漂移一天——`new Date('2026-09-10 00:00:00')` 在 +08:00 机器上
 * 解析成 2026-09-09T16:00Z（无时区标记按本地时区解析），这正是 UI 侧那把尺歪掉的根因之一。
 * 日期头是这三种形态里唯一一致的东西，只认它。
 */
function dayOriginMs(value: string): number {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).getTime();
}

/**
 * 距离 due 还有几个**案件时区日历日**。今天到期 = 0，昨天到期 = -1。
 *
 * 按日历日算不按 24 小时算：用户感知的是"还剩几天"不是"还剩几小时"，
 * 而且 Math.ceil(毫秒差) 会让同一天里的天数随时刻跳变——那正是驾驶舱那把尺的毛病。
 *
 * 【取整方式在这里不承重】两端都已归到 UTC 零点，差值恒为 86400000 的整数倍
 * （UTC 无夏令时），故 round/ceil/floor 在本函数的定义域上恒等——穷举 9153 组
 * （±4000 天，以及 2020–2035 各月 1/15/28/29/30/31 日）零分歧。写 round 只是表明
 * 这里**不做**任何隐式的取整方向选择；换成 ceil 不会改变任何一个输出
 * （变异矩阵 M7 因此存活，是等价变异体而非判据漏洞）。
 */
export function daysUntil(dueAt: string, now: Date = new Date()): number {
  return Math.round((dayOriginMs(dueAt) - dayOriginMs(caseDayOf(now))) / 86_400_000);
}
