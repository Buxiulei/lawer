// app/src/lib/agent/calc/__tests__/nianjia.test.ts
// 把 knowledge/packs/calc/nianjia-300.md 的五个算例钉成回归锚点，外加每个分支一条用例。
// 口径改了必须先改知识卡、再改这里的锚点，不许反过来「改测试让它过」。
import { describe, test, expect, afterEach } from 'vitest';
import {
  CALC_FLAG,
  MIN_WAGE_FEN_DEFAULT,
  NIANJIA_MONTHLY_PAY_DAYS,
  annualLeaveDaysFor,
  calcAnnualLeavePay,
  proratedAnnualLeaveDays,
} from '../index';

const MIN_WAGE = 254_000;
/** 月均 21,750 元 → 日工资恰好 1,000 元（21,750 ÷ 21.75），卡片例 1、例 4 用的就是这个数。 */
const WAGE_21750 = 2_175_000;
/** 月均 10,875 元 → 日工资恰好 500 元，卡片例 2 用的是这个数。 */
const WAGE_10875 = 1_087_500;

describe('annualLeaveDaysFor：按累计工作时间定档（条例第三条）', () => {
  test('不满 1 年 → 0 天（不享受）', () => {
    expect(annualLeaveDaysFor(0.5)).toBe(0);
    expect(annualLeaveDaysFor(0.99)).toBe(0);
  });

  test('满 1 年不满 10 年 → 5 天', () => {
    expect(annualLeaveDaysFor(1)).toBe(5);
    expect(annualLeaveDaysFor(8)).toBe(5);
    expect(annualLeaveDaysFor(9.99)).toBe(5);
  });

  test('满 10 年不满 20 年 → 10 天', () => {
    expect(annualLeaveDaysFor(10)).toBe(10);
    expect(annualLeaveDaysFor(12)).toBe(10);
    expect(annualLeaveDaysFor(19.99)).toBe(10);
  });

  test('满 20 年以上 → 15 天', () => {
    expect(annualLeaveDaysFor(20)).toBe(15);
    expect(annualLeaveDaysFor(35)).toBe(15);
  });
});

describe('proratedAnnualLeaveDays：折算与「不足 1 整天不支付」', () => {
  test('卡例 1：2026-06-30 离职，已过 181 天 → 181÷365×5 = 2.4795 → 2 天', () => {
    const p = proratedAnnualLeaveDays(5, '2026-06-30');
    expect(p.calendarDays).toBe(181);
    expect(p.raw).toBeCloseTo(2.4795, 4);
    expect(p.days).toBe(2);
  });

  test('卡例 2 上：2026-03-15 离职 → 74 天 → 1.0137 → 1 天', () => {
    const p = proratedAnnualLeaveDays(5, '2026-03-15');
    expect(p.calendarDays).toBe(74);
    expect(p.days).toBe(1);
  });

  test('卡例 2 下：2026-02-10 离职 → 41 天 → 0.5616 → 0 天（年初离职这一项基本拿不到）', () => {
    const p = proratedAnnualLeaveDays(5, '2026-02-10');
    expect(p.calendarDays).toBe(41);
    expect(p.days).toBe(0);
  });

  test('卡例 5（新入职当年折算，实施办法第五条）：2026-09-01 入职 → 剩余 122 天 → 1 天', () => {
    const p = proratedAnnualLeaveDays(5, '2026-12-31', '2026-09-01');
    expect(p.calendarDays).toBe(122);
    expect(p.raw).toBeCloseTo(1.6712, 4);
    expect(p.days).toBe(1);
    expect(p.from).toBe('2026-09-01');
  });

  test('整年在职 → 折算即全年应休，不因浮点掉一天', () => {
    expect(proratedAnnualLeaveDays(5, '2026-12-31').days).toBe(5);
    expect(proratedAnnualLeaveDays(10, '2026-12-31').days).toBe(10);
    expect(proratedAnnualLeaveDays(15, '2026-12-31').days).toBe(15);
    // 闰年 366 天：分母恒为 365，折算值略大于全年天数，取整后仍是全年天数。
    expect(proratedAnnualLeaveDays(5, '2024-12-31').days).toBe(5);
  });

  test('入职日早于年初的按 1 月 1 日起算', () => {
    expect(proratedAnnualLeaveDays(5, '2026-06-30', '2020-05-01').calendarDays).toBe(181);
  });

  test('入职晚于结算日抛错', () => {
    expect(() => proratedAnnualLeaveDays(5, '2026-06-30', '2026-08-01')).toThrow(/晚于/);
  });
});

describe('calcAnnualLeavePay：卡片算例锚点', () => {
  test('例 1：累计 8 年（全年 5 天）、2026-06-30 离职、已休 1 天、月均 21,750 → 2,000.00 元', () => {
    const r = calcAnnualLeavePay({
      cumulativeWorkYears: 8,
      avgMonthlyWageExOvertimeFen: WAGE_21750,
      throughDate: '2026-06-30',
      arrangedDaysThisYear: 1,
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('年假');
    expect(r.amountFen).toBe(200_000);
    expect(r.formula).toBe('1,000.00（日工资 = 21,750.00 ÷ 21.75） × 1 天 × 200% = 2,000.00 元');
    expect(r.flags).toContain(CALC_FLAG.nianjiaCumulativeTenure);
    expect(r.flags).toContain(CALC_FLAG.nianjiaSubDayDropped);
  });

  test('例 2 上：日工资 500、2026-03-15 离职、未休 → 1 天 → 1,000.00 元', () => {
    const r = calcAnnualLeavePay({
      cumulativeWorkYears: 3,
      avgMonthlyWageExOvertimeFen: WAGE_10875,
      throughDate: '2026-03-15',
      arrangedDaysThisYear: 0,
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(100_000);
  });

  test('例 2 下：2026-02-10 离职 → 折算 0 天 → 0 元', () => {
    const r = calcAnnualLeavePay({
      cumulativeWorkYears: 3,
      avgMonthlyWageExOvertimeFen: WAGE_10875,
      throughDate: '2026-02-10',
      arrangedDaysThisYear: 0,
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(0);
    expect(r.flags).toContain(CALC_FLAG.nianjiaSubDayDropped);
  });

  test('例 3：已休 5 天多于折算 2 天 → 0 元，且多休不扣回（不出现负数）', () => {
    const r = calcAnnualLeavePay({
      cumulativeWorkYears: 3,
      avgMonthlyWageExOvertimeFen: WAGE_21750,
      throughDate: '2026-06-30',
      arrangedDaysThisYear: 5,
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(0);
    expect(r.amountFen).toBeGreaterThanOrEqual(0);
    expect(r.flags).toContain(CALC_FLAG.nianjiaOverArranged);
    expect(r.steps.find((s) => s.id === 'prorate')?.detail).toContain('多休不再扣回');
  });

  test('例 4：累计 12 年（10 天）、2025+2026 两年度全未休 → 40,000.00 元', () => {
    const r = calcAnnualLeavePay({
      cumulativeWorkYears: 12,
      avgMonthlyWageExOvertimeFen: WAGE_21750,
      throughDate: '2026-12-31',
      arrangedDaysThisYear: 0,
      priorYears: [{ year: 2025, unusedDays: 10 }],
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(4_000_000);
    expect(r.steps.find((s) => s.id === 'year-2025')?.valueFen).toBe(2_000_000);
    expect(r.steps.find((s) => s.id === 'year-2026')?.valueFen).toBe(2_000_000);
    // 上一年度在保守时效口径内，不打时效风险 flag。
    expect(r.flags).not.toContain(CALC_FLAG.nianjiaShixiaoConservative);
  });
});

describe('calcAnnualLeavePay：分支', () => {
  const base = {
    cumulativeWorkYears: 8,
    avgMonthlyWageExOvertimeFen: WAGE_21750,
    throughDate: '2026-12-31',
    arrangedDaysThisYear: 0,
    minWageFen: MIN_WAGE,
  };

  test('主张的是 200% 差额不是 300%（300% 含已发的 100%）', () => {
    const r = calcAnnualLeavePay(base);
    // 全年 5 天 × 日工资 1,000 × 200% = 10,000；按 300% 写会是 15,000。
    expect(r.amountFen).toBe(1_000_000);
    expect(r.amountFen).not.toBe(1_500_000);
    expect(r.steps.at(-1)?.detail).toContain('200%');
  });

  test('累计不满 1 年 → 0 天且打「不享受」flag', () => {
    const r = calcAnnualLeavePay({ ...base, cumulativeWorkYears: 0.5 });
    expect(r.amountFen).toBe(0);
    expect(r.flags).toContain(CALC_FLAG.nianjiaNoEntitlement);
  });

  test('约定高于法定的从其约定（实施办法第十三条）', () => {
    const r = calcAnnualLeavePay({ ...base, fullYearDaysOverride: 10 });
    expect(r.amountFen).toBe(2_000_000); // 1,000 × 10 × 200%
  });

  test('早于上一年度的往年年假：出数但打时效风险 flag，不静默剔除', () => {
    const r = calcAnnualLeavePay({
      ...base,
      priorYears: [
        { year: 2023, unusedDays: 5 },
        { year: 2025, unusedDays: 5 },
      ],
    });
    // 2023 的 5 天照算进去，只是提示风险高。
    expect(r.amountFen).toBe(1_000_000 + 1_000_000 + 1_000_000);
    expect(r.flags).toContain(CALC_FLAG.nianjiaShixiaoConservative);
    expect(r.steps.find((s) => s.id === 'year-2023')?.detail).toContain('时效风险高');
    expect(r.steps.find((s) => s.id === 'year-2025')?.detail).not.toContain('时效风险高');
  });

  test('往年年度不得等于或晚于结算年度（当年度已由折算算过，防重复主张）', () => {
    expect(() =>
      calcAnnualLeavePay({ ...base, priorYears: [{ year: 2026, unusedDays: 5 }] }),
    ).toThrow(/须早于结算年度/);
    expect(() =>
      calcAnnualLeavePay({ ...base, priorYears: [{ year: 2025, unusedDays: -1 }] }),
    ).toThrow(/不能为负/);
  });

  test('月均低于最低工资 → 按最低工资兜底并打 flag', () => {
    const r = calcAnnualLeavePay({ ...base, avgMonthlyWageExOvertimeFen: 200_000 });
    expect(r.flags).toContain(CALC_FLAG.minWageFloor);
    expect(r.amountFen).toBe(Math.round((MIN_WAGE / 21.75) * 5 * 2));
  });

  test('未传最低工资 → 用内置缺省并打「最低工资缺省值待核实」', () => {
    const r = calcAnnualLeavePay({ ...base, minWageFen: undefined });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('分母是 21.75 且法条写死（不开放入参覆盖）', () => {
    expect(NIANJIA_MONTHLY_PAY_DAYS).toBe(21.75);
    expect(calcAnnualLeavePay(base).inputs.monthlyPayDays).toBe(21.75);
  });

  test('inputs 已冻结、日期归一、纯函数同输入同输出', () => {
    const r = calcAnnualLeavePay({ ...base, throughDate: '2026-12-31 09:00:00' });
    expect(Object.isFrozen(r.inputs)).toBe(true);
    expect(r.inputs.throughDate).toBe('2026-12-31');
    expect(calcAnnualLeavePay(base)).toEqual(calcAnnualLeavePay(base));
  });

  test('金额一律整数分，basis 挂到年假法条与 packId', () => {
    const r = calcAnnualLeavePay(base);
    expect(Number.isInteger(r.amountFen)).toBe(true);
    for (const s of r.steps) {
      if (s.valueFen !== undefined) expect(Number.isInteger(s.valueFen)).toBe(true);
    }
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第十一条', packId: 'calc-nianjia-300' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第62问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
  });
});

describe('年假：日期解析走 fromSql，不随本机时区漂移', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const TZS = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  // 挑 03-15 这个边界：折算值 1.0137 只比 1 多一点，日期退一天（74→73 天）就掉到 0.9999 → 0 天。
  test.each(TZS)('TZ=%s：2026-03-15 离职恒折算出 1 天、1,000.00 元', (tz) => {
    process.env.TZ = tz;
    expect(proratedAnnualLeaveDays(5, '2026-03-15 00:00:00').days).toBe(1);
    expect(proratedAnnualLeaveDays(5, '2026-03-15T00:00:00Z').days).toBe(1);
    expect(
      calcAnnualLeavePay({
        cumulativeWorkYears: 3,
        avgMonthlyWageExOvertimeFen: WAGE_10875,
        throughDate: '2026-03-15 00:00:00',
        arrangedDaysThisYear: 0,
        minWageFen: MIN_WAGE,
      }).amountFen,
    ).toBe(100_000);
  });
});
