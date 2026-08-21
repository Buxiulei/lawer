// app/src/lib/agent/calc/__tests__/bingjia.test.ts
// 把 knowledge/packs/calc/bingjia-gongzi.md 的四个算例钉成回归锚点。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect, afterEach } from 'vitest';
import {
  BINGJIA_MONTHLY_PAY_DAYS_DEFAULT,
  CALC_FLAG,
  MIN_WAGE_FEN_DEFAULT,
  calc2N,
  calcSickPay,
} from '../index';

const MIN_WAGE = 254_000;
/** 最低工资 × 80% = 2,032.00 元/月。 */
const FLOOR = 203_200;

describe('calcSickPay：卡片算例锚点', () => {
  test('例 1（约定 8,000 × 70% = 5,600 高于下限，按约定）：只发 2,032 时月差 3,568.00 元', () => {
    const r = calcSickPay({
      agreedMonthlySickPayFen: 560_000,
      months: [{ month: '2026-03', paidFen: FLOOR }],
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('病假工资');
    expect(r.inputs.standardFen).toBe(560_000);
    expect(r.inputs.floorFen).toBe(FLOOR);
    expect(r.amountFen).toBe(356_800);
    // 约定高于下限时不打兜底 flag——公司不能反过来降到 2,032。
    expect(r.flags).not.toContain(CALC_FLAG.bingjiaMinFloor);
  });

  test('例 2（约定 2,000 × 60% = 1,200 低于下限）：按 2,032 补足，月差 832.00 元', () => {
    const r = calcSickPay({
      agreedMonthlySickPayFen: 120_000,
      months: [{ month: '2026-03', paidFen: 120_000 }],
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.standardFen).toBe(FLOOR);
    expect(r.amountFen).toBe(83_200);
    expect(r.flags).toContain(CALC_FLAG.bingjiaMinFloor);
  });

  test('例 3（不满整月，下限档 10 个病假计薪日）：2,032 ÷ 21.75 × 10 = 934.25 元', () => {
    const r = calcSickPay({
      months: [{ month: '2026-03', paidFen: 0, sickPayDays: 10 }],
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.standardFen).toBe(FLOOR);
    expect(r.inputs.monthlyPayDays).toBe(BINGJIA_MONTHLY_PAY_DAYS_DEFAULT);
    expect(r.amountFen).toBe(93_425);
    expect(r.flags).toContain(CALC_FLAG.bingjiaPartialMonth);
    // 21.75 与工资支付规定第四十三条的 20.92 之争，与加班费同一条 flag。
    expect(r.flags).toContain(CALC_FLAG.jiabanDivisorDisputed);
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.detail).toContain('当月其余计薪日');
  });

  test('例 4（医疗期内被解除 = 违法解除）：2N = 300,000 元，病假差额并行主张不被吸收', () => {
    // 医疗期内以「部门撤销、经济性裁员」解除的，第四十二条第三项挡住第 40、41 条 → 违法解除。
    const twoN = calc2N({
      avgMonthlyWageFen: 2_500_000,
      employedFrom: '2020-03-01',
      terminatedAt: '2026-03-01',
      minWageFen: MIN_WAGE,
    });
    expect(twoN.amountFen).toBe(30_000_000);

    const sick = calcSickPay({
      agreedMonthlySickPayFen: 120_000,
      months: [{ month: '2026-01', paidFen: 120_000 }],
      minWageFen: MIN_WAGE,
    });
    expect(sick.amountFen).toBe(83_200);
    expect(sick.flags).toContain(CALC_FLAG.bingjiaMedicalPeriodProtected);
    expect(sick.steps.find((s) => s.id === 'amount')?.detail).toContain('并行主张');
  });
});

describe('calcSickPay：分支与恒发提示', () => {
  test('未约定标准：按法定下限出数，并提示可主张按正常工资（争议点 2）', () => {
    const r = calcSickPay({ months: [{ month: '2026-03', paidFen: 0 }], minWageFen: MIN_WAGE });
    expect(r.inputs.standardFen).toBe(FLOOR);
    expect(r.amountFen).toBe(FLOOR);
    expect(r.flags).toContain(CALC_FLAG.bingjiaNoAgreedStandard);
    expect(r.flags).toContain(CALC_FLAG.bingjiaMinFloor);
    expect(r.steps.find((s) => s.id === 'standard')?.detail).toContain('按正常工资');
  });

  test('多月逐月各算一笔：某月实发多于应付的记 0，不与其他月抵扣', () => {
    const r = calcSickPay({
      agreedMonthlySickPayFen: 500_000,
      months: [
        { month: '2026-03', paidFen: 800_000 },
        { month: '2026-04', paidFen: 100_000 },
        { month: '2026-05', paidFen: FLOOR },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.valueFen).toBe(0);
    expect(r.steps.find((s) => s.id === 'month-2026-04')?.valueFen).toBe(400_000);
    expect(r.steps.find((s) => s.id === 'month-2026-05')?.valueFen).toBe(296_800);
    expect(r.amountFen).toBe(696_800);
  });

  test('折算分母可覆盖成 20.92（个别单位仍按工资支付规定第四十三条计发）', () => {
    const r = calcSickPay({
      months: [{ month: '2026-03', paidFen: 0, sickPayDays: 10 }],
      minWageFen: MIN_WAGE,
      monthlyPayDays: 20.92,
    });
    expect(r.amountFen).toBe(97_132);
    expect(r.flags).toContain(CALC_FLAG.jiabanDivisorDisputed);
  });

  test('恒发四条提示：病假≠事假、医疗期不得解除、医疗期档次待核实、医疗期满转待岗存争议', () => {
    const r = calcSickPay({ months: [{ month: '2026-03', paidFen: 0 }], minWageFen: MIN_WAGE });
    expect(r.flags).toContain(CALC_FLAG.bingjiaNotPersonalLeave);
    expect(r.flags).toContain(CALC_FLAG.bingjiaMedicalPeriodProtected);
    expect(r.flags).toContain(CALC_FLAG.bingjiaMedicalPeriodLengthUnknown);
    expect(r.flags).toContain(CALC_FLAG.bingjiaStandbyAfterMedicalDisputed);
  });

  test('未给最低工资时用内置缺省并打「待核实」', () => {
    const r = calcSickPay({ months: [{ month: '2026-03', paidFen: 0 }] });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.inputs.floorFen).toBe(FLOOR);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('入参非法直接抛错', () => {
    expect(() => calcSickPay({ months: [] })).toThrow('months 不能为空');
    expect(() =>
      calcSickPay({
        months: [
          { month: '2026-04', paidFen: 0 },
          { month: '2026-03', paidFen: 0 },
        ],
      }),
    ).toThrow('months 必须按月份升序且不重复');
    expect(() => calcSickPay({ months: [{ month: '2026-13', paidFen: 0 }] })).toThrow(
      '不是真实存在的月份',
    );
  });

  test('basis 挂到工资支付规定第二十一条与 534 号第 57 问第 5 项，inputs 已冻结', () => {
    const r = calcSickPay({ months: [{ month: '2026-03', paidFen: 0 }], minWageFen: MIN_WAGE });
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第二十一条', packId: 'calc-bingjia-gongzi' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第57问第5项', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
    expect(Object.isFrozen(r.inputs)).toBe(true);
  });
});

describe('病假：月份解析不随本机时区漂移', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const TZS = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  // 挑 12 月与 1 月这一对：跨年月份在 UTC±12 的机器上最容易被解析成邻月，
  // 一旦漂到邻月，升序校验会误报、steps 的月份标题也会错位。
  test.each(TZS)('TZ=%s：跨年三个月的差额与月份标题恒定', (tz) => {
    process.env.TZ = tz;
    const r = calcSickPay({
      agreedMonthlySickPayFen: 500_000,
      months: [
        { month: '2025-12', paidFen: 0 },
        { month: '2026-01', paidFen: 0 },
        { month: '2026-02', paidFen: 0, sickPayDays: 10 },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(1_229_885);
    expect(r.steps.map((s) => s.id)).toEqual([
      'standard',
      'month-2025-12',
      'month-2026-01',
      'month-2026-02',
      'amount',
    ]);
  });
});
