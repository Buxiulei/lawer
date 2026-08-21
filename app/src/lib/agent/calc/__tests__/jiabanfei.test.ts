// app/src/lib/agent/calc/__tests__/jiabanfei.test.ts
// 把 knowledge/packs/calc/jiabanfei.md 的四个算例钉成回归锚点（含 21.75 与 20.92 两套折算）。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect } from 'vitest';
import {
  CALC_FLAG,
  JIABAN_MONTHLY_WORK_DAYS_DEFAULT,
  JIABAN_MONTHLY_WORK_DAYS_LEGACY,
  MIN_WAGE_FEN_DEFAULT,
  calcOvertimePay,
} from '../index';

const MIN_WAGE = 254_000;
/** 基数 10,875 元/月 → 按 21.75 折算日基数恰好 500 元、小时 62.50 元。 */
const BASE_10875 = 1_087_500;

describe('calcOvertimePay：卡片算例锚点', () => {
  test('例 1（三档混合，按 21.75）：937.50 + 2,000.00 + 1,500.00 = 4,437.50 元', () => {
    const r = calcOvertimePay({
      monthlyBaseFen: BASE_10875,
      weekdayOvertimeHours: 10,
      restDayDays: 2,
      holidayDays: 1,
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('加班费');
    expect(r.steps.find((s) => s.id === 'base')?.valueFen).toBe(50_000); // 日基数 500.00
    expect(r.steps.find((s) => s.id === 'weekday')?.valueFen).toBe(93_750);
    expect(r.steps.find((s) => s.id === 'rest-day')?.valueFen).toBe(200_000);
    expect(r.steps.find((s) => s.id === 'holiday')?.valueFen).toBe(150_000);
    expect(r.amountFen).toBe(443_750);
    expect(r.formula).toContain('= 4,437.50 元');
  });

  test('例 2（同量按 20.92 折算）：974.70 + 2,079.35 + 1,559.51 = 4,613.56 元', () => {
    const r = calcOvertimePay({
      monthlyBaseFen: BASE_10875,
      weekdayOvertimeHours: 10,
      restDayDays: 2,
      holidayDays: 1,
      monthlyWorkDays: JIABAN_MONTHLY_WORK_DAYS_LEGACY,
      minWageFen: MIN_WAGE,
    });
    expect(r.steps.find((s) => s.id === 'weekday')?.valueFen).toBe(97_470);
    expect(r.steps.find((s) => s.id === 'rest-day')?.valueFen).toBe(207_935);
    expect(r.steps.find((s) => s.id === 'holiday')?.valueFen).toBe(155_951);
    expect(r.amountFen).toBe(461_356);
    expect(r.flags).toContain(CALC_FLAG.jiabanLegacyDivisor);
  });

  test('例 2 续：分母越小日工资越高，按 20.92 比 21.75 多 176.06 元/月', () => {
    const args = {
      monthlyBaseFen: BASE_10875,
      weekdayOvertimeHours: 10,
      restDayDays: 2,
      holidayDays: 1,
      minWageFen: MIN_WAGE,
    };
    const by2175 = calcOvertimePay(args);
    const by2092 = calcOvertimePay({ ...args, monthlyWorkDays: JIABAN_MONTHLY_WORK_DAYS_LEGACY });
    expect(by2092.amountFen - by2175.amountFen).toBe(17_606);
  });

  test('例 3（合同把基数压到最低工资）：1,051.03 元 vs 击破后 8,275.86 元，差 7,224.83 元', () => {
    const byCompany = calcOvertimePay({
      monthlyBaseFen: MIN_WAGE,
      holidayDays: 3,
      minWageFen: MIN_WAGE,
    });
    const byActual = calcOvertimePay({
      monthlyBaseFen: 2_000_000,
      holidayDays: 3,
      minWageFen: MIN_WAGE,
    });
    expect(byCompany.amountFen).toBe(105_103);
    expect(byActual.amountFen).toBe(827_586);
    expect(byActual.amountFen - byCompany.amountFen).toBe(722_483);
    // 先把基数打上去、再谈小时数——这条提示恒随结果给出。
    expect(byCompany.flags).toContain(CALC_FLAG.jiabanBaseRule);
  });

  test('例 4 上（休息日已安排补休）：未补休天数为 0 → 该档 0 元', () => {
    const r = calcOvertimePay({
      monthlyBaseFen: BASE_10875,
      restDayDays: 0,
      minWageFen: MIN_WAGE,
    });
    expect(r.steps.find((s) => s.id === 'rest-day')?.valueFen).toBe(0);
    expect(r.amountFen).toBe(0);
  });

  test('例 4 下（法定节假日加班安排了补休）：补休不能替代，仍付日基数 × 3', () => {
    const r = calcOvertimePay({
      monthlyBaseFen: BASE_10875,
      holidayDays: 1,
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(150_000);
    expect(r.flags).toContain(CALC_FLAG.jiabanHolidayNoSwap);
  });
});

describe('calcOvertimePay：三档倍数与分支', () => {
  const base = { monthlyBaseFen: BASE_10875, minWageFen: MIN_WAGE };

  test('三档倍数分别是 150% / 200% / 300%', () => {
    // 同样 8 小时（= 1 天），三档金额之比应为 1.5 : 2 : 3。
    const weekday = calcOvertimePay({ ...base, weekdayOvertimeHours: 8 }).amountFen;
    const rest = calcOvertimePay({ ...base, restDayDays: 1 }).amountFen;
    const holiday = calcOvertimePay({ ...base, holidayDays: 1 }).amountFen;
    expect(weekday).toBe(75_000); // 500 × 1.5
    expect(rest).toBe(100_000); // 500 × 2
    expect(holiday).toBe(150_000); // 500 × 3
  });

  test('休息日与法定节假日支持零星小时', () => {
    const r = calcOvertimePay({ ...base, restDayHours: 4, holidayHours: 2 });
    expect(r.steps.find((s) => s.id === 'rest-day')?.valueFen).toBe(50_000); // 62.50 × 4 × 200%
    expect(r.steps.find((s) => s.id === 'holiday')?.valueFen).toBe(37_500); // 62.50 × 2 × 300%
    expect(r.formula).toContain('+4h');
  });

  test('小时基数 = 日基数 ÷ 8（即月基数 ÷ 174）', () => {
    const r = calcOvertimePay({ ...base, weekdayOvertimeHours: 174 });
    // 174 小时 × 小时基数 = 月基数；再 × 150%。
    expect(r.amountFen).toBe(Math.round(BASE_10875 * 1.5));
  });

  test('基数低于最低工资 → 按最低工资兜底（工资支付规定第四十四条末款）', () => {
    const r = calcOvertimePay({ monthlyBaseFen: 200_000, holidayDays: 3, minWageFen: MIN_WAGE });
    expect(r.amountFen).toBe(105_103); // 与例 3 公司口径同值
    expect(r.flags).toContain(CALC_FLAG.minWageFloor);
  });

  test('未传最低工资 → 用缺省并打待核实 flag', () => {
    const r = calcOvertimePay({ monthlyBaseFen: BASE_10875, holidayDays: 1 });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('折算天数之争恒作为 flag 给出（21.75 是主流，20.92 是可争取项）', () => {
    expect(JIABAN_MONTHLY_WORK_DAYS_DEFAULT).toBe(21.75);
    expect(JIABAN_MONTHLY_WORK_DAYS_LEGACY).toBe(20.92);
    const r = calcOvertimePay({ ...base, holidayDays: 1 });
    expect(r.inputs.monthlyWorkDays).toBe(21.75);
    expect(r.flags).toContain(CALC_FLAG.jiabanDivisorDisputed);
    expect(r.flags).not.toContain(CALC_FLAG.jiabanLegacyDivisor);
  });

  test('三档分项之和恒等于总额（各档分别取整）', () => {
    const r = calcOvertimePay({
      monthlyBaseFen: 1_000_000,
      weekdayOvertimeHours: 7,
      restDayDays: 3,
      restDayHours: 5,
      holidayDays: 2,
      holidayHours: 3,
      monthlyWorkDays: JIABAN_MONTHLY_WORK_DAYS_LEGACY,
      minWageFen: MIN_WAGE,
    });
    const tiers = ['weekday', 'rest-day', 'holiday'].map(
      (id) => r.steps.find((s) => s.id === id)?.valueFen ?? 0,
    );
    expect(tiers.reduce((a, b) => a + b, 0)).toBe(r.amountFen);
  });

  test('契约通用项：inputs 冻结、整数分、basis 挂法条、同输入同输出', () => {
    const r = calcOvertimePay({ ...base, weekdayOvertimeHours: 10, holidayDays: 1 });
    expect(Object.isFrozen(r.inputs)).toBe(true);
    expect(Number.isInteger(r.amountFen)).toBe(true);
    for (const s of r.steps) {
      if (s.valueFen !== undefined) expect(Number.isInteger(s.valueFen)).toBe(true);
    }
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第十四条', packId: 'calc-jiabanfei' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第57问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
    expect(calcOvertimePay(base)).toEqual(calcOvertimePay(base));
  });
});
