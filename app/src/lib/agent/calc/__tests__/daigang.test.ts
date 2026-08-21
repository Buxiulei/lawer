// app/src/lib/agent/calc/__tests__/daigang.test.ts
// 把 knowledge/packs/calc/daigang-gongzi.md 的四个算例钉成回归锚点。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect } from 'vitest';
import {
  CALC_FLAG,
  DAIGANG_LIVING_ALLOWANCE_RATE,
  DAIGANG_MONTHLY_PAY_DAYS_DEFAULT,
  MIN_WAGE_FEN_DEFAULT,
  calcStandbyWage,
} from '../index';

const MIN_WAGE = 254_000;
/** 最低工资 × 70% = 1,778.00 元。 */
const LIVING = 177_800;

describe('calcStandbyWage：卡片算例锚点', () => {
  test('例 1（标准两段）：3 月全额无差额，4/5 月各差 278.00 → 合计 556.00 元', () => {
    const r = calcStandbyWage({
      normalMonthlyWageFen: 2_000_000,
      providesLabor: false,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: 150_000 },
        { month: '2026-05', paidFen: 150_000 },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('待岗工资');
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.valueFen).toBe(0);
    expect(r.steps.find((s) => s.id === 'month-2026-04')?.valueFen).toBe(27_800);
    expect(r.steps.find((s) => s.id === 'month-2026-05')?.valueFen).toBe(27_800);
    expect(r.amountFen).toBe(55_600);
    expect(r.inputs.livingAllowanceFen).toBe(LIVING);
    expect(r.flags).toContain(CALC_FLAG.daigangLivingAllowance);
  });

  test('例 2（超周期但仍提供劳动）：下限从 1,778 变 2,540 → 差额 1,524.00 元', () => {
    const r = calcStandbyWage({
      normalMonthlyWageFen: 2_000_000,
      providesLabor: true,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: LIVING },
        { month: '2026-05', paidFen: LIVING },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(152_400);
    expect(r.flags).toContain(CALC_FLAG.daigangProvidesLabor);
    expect(r.flags).not.toContain(CALC_FLAG.daigangLivingAllowance);
  });

  test('例 1 与例 2 只差「有没有安排工作」这一个事实点：762.00 元/月', () => {
    const common = {
      normalMonthlyWageFen: 2_000_000,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: LIVING },
      ],
      minWageFen: MIN_WAGE,
    };
    const b = calcStandbyWage({ ...common, providesLabor: false });
    const a = calcStandbyWage({ ...common, providesLabor: true });
    expect(b.amountFen).toBe(0);
    expect(a.amountFen).toBe(76_200);
  });

  test('例 3（只对个别员工待岗）：第 27 条不适用，按合同全额 → 每月差 28,222.00 元', () => {
    const r = calcStandbyWage({
      normalMonthlyWageFen: 3_000_000,
      providesLabor: false,
      genuineStoppage: false,
      months: [{ month: '2026-04', paidFen: LIVING }],
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(2_822_200);
    expect(r.flags).toContain(CALC_FLAG.daigangNotGenuineStoppage);
    expect(r.steps.find((s) => s.id === 'not-stoppage')?.detail).toContain('第三十八条第二项');
    // 未停工停业时不存在「首个支付周期」的分段问题。
    expect(r.flags).not.toContain(CALC_FLAG.daigangFirstCycleDisputed);
  });

  test('例 4（不满整月按 21.75 折算）：1,778 ÷ 21.75 × 10 = 817.47 元', () => {
    const r = calcStandbyWage({
      normalMonthlyWageFen: 2_000_000,
      providesLabor: false,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: 0, payDays: 10 },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.steps.find((s) => s.id === 'month-2026-04')?.valueFen).toBe(81_747);
    expect(r.amountFen).toBe(81_747);
    expect(r.flags).toContain(CALC_FLAG.daigangPartialMonth);
  });
});

describe('calcStandbyWage：分段与分支', () => {
  const base = {
    normalMonthlyWageFen: 2_000_000,
    providesLabor: false,
    minWageFen: MIN_WAGE,
  };

  test('第 1 个工资支付周期按正常工资全额，不是最低工资也不是 70%', () => {
    const r = calcStandbyWage({
      ...base,
      months: [
        { month: '2026-03', paidFen: 0 },
        { month: '2026-04', paidFen: 0 },
      ],
    });
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.valueFen).toBe(2_000_000);
    expect(r.steps.find((s) => s.id === 'month-2026-04')?.valueFen).toBe(LIVING);
    expect(r.flags).toContain(CALC_FLAG.daigangFirstCycleDisputed);
  });

  test('每段一个 step，逐月分项之和等于总额', () => {
    const r = calcStandbyWage({
      ...base,
      months: [
        { month: '2026-03', paidFen: 500_000 },
        { month: '2026-04', paidFen: 100_000 },
        { month: '2026-05', paidFen: 0 },
      ],
    });
    const monthly = r.steps
      .filter((s) => s.id.startsWith('month-'))
      .reduce((sum, s) => sum + (s.valueFen ?? 0), 0);
    expect(monthly).toBe(r.amountFen);
    expect(r.amountFen).toBe(1_500_000 + 77_800 + LIVING);
  });

  test('情形 A 取双方新约定标准，低于最低工资的按最低工资兜底', () => {
    const agreed = calcStandbyWage({
      ...base,
      providesLabor: true,
      agreedMonthlyWageFen: 800_000,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: 0 },
      ],
    });
    expect(agreed.amountFen).toBe(800_000);

    const belowFloor = calcStandbyWage({
      ...base,
      providesLabor: true,
      agreedMonthlyWageFen: 100_000,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: 0 },
      ],
    });
    expect(belowFloor.amountFen).toBe(MIN_WAGE);
    expect(belowFloor.flags).toContain(CALC_FLAG.minWageFloor);
  });

  test('某月实发多于应付的记 0，不与其他月抵扣（各月工资是各自到期的债）', () => {
    const r = calcStandbyWage({
      ...base,
      months: [
        { month: '2026-03', paidFen: 5_000_000 }, // 多发 300 万
        { month: '2026-04', paidFen: 0 },
      ],
    });
    expect(r.amountFen).toBe(LIVING);
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.detail).toContain('不与其他月抵扣');
  });

  test('生活费比例 70%、折算分母 21.75，最低工资可覆盖', () => {
    expect(DAIGANG_LIVING_ALLOWANCE_RATE).toBe(0.7);
    expect(DAIGANG_MONTHLY_PAY_DAYS_DEFAULT).toBe(21.75);
    const r = calcStandbyWage({
      ...base,
      minWageFen: 300_000,
      months: [
        { month: '2026-03', paidFen: 2_000_000 },
        { month: '2026-04', paidFen: 0 },
      ],
    });
    expect(r.inputs.livingAllowanceFen).toBe(210_000); // 3,000 × 70%
    expect(r.amountFen).toBe(210_000);
  });

  test('未传最低工资 → 用缺省并打待核实 flag', () => {
    const r = calcStandbyWage({
      ...base,
      minWageFen: undefined,
      months: [{ month: '2026-03', paidFen: 0 }],
    });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('months 必须非空、升序、不重复', () => {
    expect(() => calcStandbyWage({ ...base, months: [] })).toThrow(/不能为空/);
    expect(() =>
      calcStandbyWage({
        ...base,
        months: [
          { month: '2026-04', paidFen: 0 },
          { month: '2026-03', paidFen: 0 },
        ],
      }),
    ).toThrow(/升序/);
    expect(() =>
      calcStandbyWage({ ...base, months: [{ month: '2026-13', paidFen: 0 }] }),
    ).toThrow(/不是真实存在的月份/);
  });

  test('契约通用项：inputs 冻结、整数分、basis 挂法条、同输入同输出', () => {
    const input = {
      ...base,
      months: [
        { month: '2026-03', paidFen: 0 },
        { month: '2026-04', paidFen: 0 },
      ],
    };
    const r = calcStandbyWage(input);
    expect(Object.isFrozen(r.inputs)).toBe(true);
    expect(Number.isInteger(r.amountFen)).toBe(true);
    for (const s of r.steps) {
      if (s.valueFen !== undefined) expect(Number.isInteger(s.valueFen)).toBe(true);
    }
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第二十七条', packId: 'calc-daigang-gongzi' }),
    );
    expect(calcStandbyWage(input)).toEqual(calcStandbyWage(input));
  });
});
