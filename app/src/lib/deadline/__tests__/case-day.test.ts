// app/src/lib/deadline/__tests__/case-day.test.ts
// 倒计时只许有一把尺。
//
// 【判据为什么长这样】"两处算法不同"这种缺陷，单看任何一处都是对的——
// 只有把两个**公开入口**放在同一个时刻上比，分歧才显形。所以这里不测实现，
// 测的是 `@/app/_ui/format`（驾驶舱）与 `@/lib/notify/deadline-reminder`（邮件）
// 这两个 import 路径在同一输入上必须给同一个数。谁哪天又在某处手写一遍，这里就红。
//
// 【对照臂】修复前的两个实现逐字保留在下面。没有它们，"新实现给 0"只是一句
// 和判据并存的文字——看不出这个判据能不能把旧代码判死（旧实现必须让矩阵红）。
import { afterEach, describe, expect, test } from 'vitest';

import { daysUntil as uiDaysUntil, formatCountdown } from '@/app/_ui/format';
import { caseDayOf, daysUntil } from '@/lib/deadline/case-day';
import { daysUntil as mailDaysUntil } from '@/lib/notify/deadline-reminder';

/** 修复前**驾驶舱**那把尺，逐字保留（app/src/app/_ui/format.ts @6413dc5）。 */
function daysUntilCeilLegacy(dueIso: string, now: Date): number {
  const due = new Date(dueIso).getTime();
  return Math.ceil((due - now.getTime()) / 86_400_000);
}

/** 修复前**邮件**那把尺，逐字保留（app/src/lib/notify/deadline-reminder.ts @6413dc5）。 */
function daysUntilLocalLegacy(dueAt: string, now: Date): number {
  const due = new Date(`${dueAt.slice(0, 10)}T00:00:00Z`).getTime();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

/**
 * 【对照臂必须自带时区】旧的两把尺都读**进程本地时区**：ceil 尺里
 * `new Date('2026-09-10 00:00:00')`（无时区标记）按本地解析，local 尺里
 * `now.getFullYear()` 系列取本地日历日。所以"旧尺会怎么错"这类**先验断言**
 * 在不同机器上结论不同——机器 TZ 是断言的隐藏输入。
 *
 * 2026-08-31 起 main 连红就是这么来的：开发机 TZ=Asia/Shanghai 时三种形态确实分裂，
 * 而 CI runner 是 UTC，`'2026-09-10 00:00:00'` 与 `'2026-09-10'` 解析成同一时刻 ⇒
 * 分裂消失 ⇒ 对照臂垮掉。**同一句断言，绿或红取决于跑它的机器**。
 *
 * 修法不是给 CI 设 TZ 了事（那只是把隐藏输入换个地方藏），而是把时区**写进断言**：
 * 旧邮件尺的产线口径本来就是"部署时把 TZ 设成 Asia/Shanghai"，那就在这里钉死北京时间。
 * 被测的新尺不需要这个（它自带案件时区），最后那个 describe 专门盯着这一点。
 */
function withCaseTz<T>(fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  // 先验量具：确认 TZ 真的换动了。改不动就说明下面整段是在别的时区上跑的，
  // 那时无论绿红都不算数 —— 宁可在这里炸，不要在那里给假结论。
  expect(new Date('2026-01-01 00:00:00').toISOString(), 'process.env.TZ 未生效').toBe(
    '2025-12-31T16:00:00.000Z',
  );
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

const DUE = '2026-09-10';

/**
 * due_at 在系统里真实出现过的三种形态。
 * 一把合格的尺对这三种必须给同一个数——它们说的本来就是同一个日子。
 */
const DUE_FORMS: Record<string, string> = {
  // 库里的实况：insertDeadline 走 SQLite `datetime(?)`，产出无时区标记的空格串
  'DB datetime()': `${DUE} 00:00:00`,
  // computeDeadline 的直接产物
  纯日期: DUE,
  // 演示数据 _mock/clock.ts demoDay(n, '23:59')
  'demoDay +08:00': `${DUE}T23:59:00+08:00`,
};

/** 到期日当天的北京时刻。08:00 是 UTC 换日点，两侧都要覆盖。 */
const HOURS = [0, 2, 6, 7, 8, 9, 12, 17, 20, 23];
const atBeijing = (day: string, hour: number) =>
  new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`);

describe('案件时区日历日', () => {
  test('caseDayOf 取的是北京日历日，不是 UTC 日', () => {
    // 北京 09-10 07:00 == UTC 09-09 23:00：这一个小时的差就是全部 bug 的来源
    const t = atBeijing(DUE, 7);
    expect(t.toISOString().slice(0, 10)).toBe('2026-09-09'); // 先验量具：UTC 确实还停在昨天
    expect(caseDayOf(t)).toBe('2026-09-10');
  });

  test('今天=0，明天=1，昨天=-1，跨月正确', () => {
    const noon = atBeijing(DUE, 12);
    expect(daysUntil(DUE, noon)).toBe(0);
    expect(daysUntil('2026-09-11', noon)).toBe(1);
    expect(daysUntil('2026-09-09', noon)).toBe(-1);
    expect(daysUntil('2026-10-10', noon)).toBe(30);
  });

  test('三种 due_at 形态给同一个数 —— 存储格式不许改变"还剩几天"', () => {
    for (const hour of HOURS) {
      const now = atBeijing(DUE, hour);
      const got = Object.values(DUE_FORMS).map((f) => daysUntil(f, now));
      expect(new Set(got), `北京 ${hour}:00 → ${JSON.stringify(got)}`).toEqual(new Set([0]));
    }
  });

  test('先验对照臂：旧的 ceil 尺对这三种形态本来就给不出同一个数', () => {
    // 【仪器错 vs 范围错】上一条若因为判据太松而恒绿，这一条会先垮——
    // 它要求同一个判据施加在旧实现上必然分裂。
    withCaseTz(() => {
      const now = atBeijing(DUE, 7);
      const legacy = Object.values(DUE_FORMS).map((f) => daysUntilCeilLegacy(f, now));
      expect(new Set(legacy).size, JSON.stringify(legacy)).toBeGreaterThan(1);
    });
  });
});

describe('🔴 驾驶舱与邮件必须是同一把尺', () => {
  test('🔑 期限当天早 7 点：UI 与邮件都说「今天」', () => {
    // 这就是派单里那个现场：驾驶舱写「还剩 1 天」、邮件写「今天到期」，
    // 方向是让人以为还有余量 —— 期限错过即权利灭失，这个方向一次都不能有。
    const at0700 = atBeijing(DUE, 7);
    for (const [name, form] of Object.entries(DUE_FORMS)) {
      expect(uiDaysUntil(form, at0700), name).toBe(0);
      expect(mailDaysUntil(form, at0700), name).toBe(0);
      expect(formatCountdown(form, at0700), name).toBe('今天到期');
    }
  });

  test('🔑 全时刻×全形态矩阵：UI 与邮件零分歧', () => {
    const disagreements: string[] = [];
    for (const day of ['2026-09-08', '2026-09-09', DUE, '2026-09-11']) {
      for (const [name, form] of Object.entries(DUE_FORMS)) {
        for (const hour of HOURS) {
          const now = atBeijing(day, hour);
          const u = uiDaysUntil(form, now);
          const m = mailDaysUntil(form, now);
          if (u !== m) disagreements.push(`${name} @ 北京 ${day} ${hour}:00 → UI=${u} 邮件=${m}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  test('先验对照臂：同一个矩阵施加在旧的两把尺上必然出现分歧', () => {
    // 没有这一条，上面那条"零分歧"可能只是因为矩阵根本没覆盖到出事的时刻。
    const disagreements = withCaseTz(() => {
      const found: string[] = [];
      for (const day of ['2026-09-08', '2026-09-09', DUE, '2026-09-11']) {
        for (const [name, form] of Object.entries(DUE_FORMS)) {
          for (const hour of HOURS) {
            const now = atBeijing(day, hour);
            const u = daysUntilCeilLegacy(form, now);
            const m = daysUntilLocalLegacy(form, now);
            if (u !== m) found.push(`${name} @ ${day} ${hour}:00 → UI=${u} 邮件=${m}`);
          }
        }
      }
      return found;
    });
    expect(disagreements.length).toBeGreaterThan(0);
    // 且分歧的方向是 UI 恒**不小于**邮件，即驾驶舱那侧在夸大剩余时间。
    // 【这条方向断言尤其吃时区】机器在美西时，local 尺的"今天"比北京早一天，
    // 方向会整个翻过来（UI=2 邮件=3）——所以它必须跑在上面那个钉死的北京时间里。
    for (const d of disagreements) {
      const [, u, m] = /UI=(-?\d+) 邮件=(-?\d+)/.exec(d)!;
      expect(Number(u), d).toBeGreaterThan(Number(m));
    }
  });

  test('🔴 期限次日凌晨：驾驶舱不再把已逾期的说成「今天到期」', () => {
    // 旧 ceil 尺在北京 09-11 00:30 对 due=09-10 给 -0（=== 0）⇒ 文案「今天到期」，
    // 而它昨天就届满了。这同样是"以为还有余量"。
    const nextDay0030 = new Date('2026-09-10T16:30:00Z'); // 北京 09-11 00:30
    // 用 === 不用 toBe：Math.ceil 在这里给的是 -0，而 Object.is(-0, 0) 为 false，
    // toBe(0) 会红在一个与本判据无关的地方。文案侧 `days === 0` 走的正是 === 。
    expect(daysUntilCeilLegacy(DUE, nextDay0030) === 0).toBe(true);
    expect(formatCountdown(DUE, nextDay0030)).toBe('已逾期 1 天');
    expect(mailDaysUntil(DUE, nextDay0030)).toBe(-1);
  });
});

describe('🔴 不受进程时区摆布', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /**
   * 【为什么这条重要】旧的邮件尺契约是"按**进程本地**日历日"，靠部署时把 TZ 设成
   * Asia/Shanghai 保证正确——那是一个没人守着的环境变量，容器忘了设就退化成 UTC，
   * 等于把「CST 00:00–08:00 多算一天」静默改回去。而修好之后这个函数还要跑在
   * **浏览器**里，浏览器时区更不是我们能约束的东西。所以尺子锚死在案件时区。
   */
  test('🔑 换任何进程时区，天数与逐日键都不变', () => {
    const at0700 = atBeijing(DUE, 7);
    const expectedDays = 0;
    const expectedDay = '2026-09-10';

    for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      // 量具是否真的换动了，由下面那条对照臂负责断言 —— 在这里写
      // expect(x).toBe(x) 那种"自证"只会制造假绿。
      expect(daysUntil(DUE, at0700), tz).toBe(expectedDays);
      expect(uiDaysUntil(DUE, at0700), tz).toBe(expectedDays);
      expect(mailDaysUntil(DUE, at0700), tz).toBe(expectedDays);
      expect(caseDayOf(at0700), tz).toBe(expectedDay);
    }
  });

  test('先验对照臂：旧的两把尺确实会被进程时区改写', () => {
    // 【自造对照有系统性折价】所以这条不由我断言"会差多少"，只断言"它随 TZ 变"——
    // 一旦它不随 TZ 变，说明 TZ 根本没生效，上一条的四轮全是假绿。
    const at0700 = atBeijing(DUE, 7);
    const seen = new Set<number>();
    for (const tz of ['Asia/Shanghai', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      seen.add(daysUntilLocalLegacy(DUE, at0700));
    }
    expect(seen.size, 'process.env.TZ 未生效 ⇒ 时区无关性那条是假绿').toBeGreaterThan(1);
  });
});
