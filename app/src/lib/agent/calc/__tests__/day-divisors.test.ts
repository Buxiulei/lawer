// app/src/lib/agent/calc/__tests__/day-divisors.test.ts
// 双常量对照：年假的 21.75 与加班费的 20.92 是**两个不同法源**的折算天数，谁把它们搞混，这里必红。
//
//   · 年假   NIANJIA_MONTHLY_PAY_DAYS = 21.75
//            《企业职工带薪年休假实施办法》第十一条**写死**，不受任何折算之争影响，不开放覆盖。
//   · 加班费 JIABAN_MONTHLY_WORK_DAYS_DEFAULT = 21.75（534 号第 57 问第 5 项，实务主流）
//            JIABAN_MONTHLY_WORK_DAYS_LEGACY  = 20.92（《北京市工资支付规定》第四十三条，可争取项）
//
// 加班费缺省与年假同为 21.75（卡片结论：本卡按 21.75 出数），所以对照必须拿加班费的 20.92
// 那一档来做——两条算式喂同一个月工资，落到两个不同的锚点值上。
import { describe, test, expect } from 'vitest';
import {
  JIABAN_MONTHLY_WORK_DAYS_DEFAULT,
  JIABAN_MONTHLY_WORK_DAYS_LEGACY,
  NIANJIA_MONTHLY_PAY_DAYS,
  calcAnnualLeavePay,
  calcOvertimePay,
} from '../index';

/** 同一个月工资喂给两条算式：10,875 元。÷21.75 = 500.00，÷20.92 = 519.8374…。 */
const WAGE = 1_087_500;
const MIN_WAGE = 254_000;

describe('21.75 与 20.92：两个折算天数常量不得互换', () => {
  test('常量本身与卡片一致', () => {
    expect(NIANJIA_MONTHLY_PAY_DAYS).toBe(21.75);
    expect(JIABAN_MONTHLY_WORK_DAYS_DEFAULT).toBe(21.75);
    expect(JIABAN_MONTHLY_WORK_DAYS_LEGACY).toBe(20.92);
    expect(NIANJIA_MONTHLY_PAY_DAYS).not.toBe(JIABAN_MONTHLY_WORK_DAYS_LEGACY);
  });

  test('同一月工资：年假日工资 500.00（÷21.75），加班费日基数 519.84（÷20.92）', () => {
    // 年假：全年 5 天全未休、整年在职 → 差额 = 日工资 × 5 × 200%，倒推日工资。
    const nianjia = calcAnnualLeavePay({
      cumulativeWorkYears: 3,
      avgMonthlyWageExOvertimeFen: WAGE,
      throughDate: '2026-12-31',
      arrangedDaysThisYear: 0,
      minWageFen: MIN_WAGE,
    });
    expect(nianjia.amountFen).toBe(500_000); // 500.00 × 5 天 × 200% = 5,000.00 元
    expect(nianjia.formula).toContain('÷ 21.75');
    // 若误用 20.92：500,000 会变成 519,837，这一行先红。
    expect(nianjia.amountFen).not.toBe(Math.round((WAGE / 20.92) * 5 * 2));

    // 加班费按 20.92：法定节假日 1 天 = 日基数 × 300%，倒推日基数 519.8374…。
    const jiaban = calcOvertimePay({
      monthlyBaseFen: WAGE,
      holidayDays: 1,
      monthlyWorkDays: JIABAN_MONTHLY_WORK_DAYS_LEGACY,
      minWageFen: MIN_WAGE,
    });
    expect(jiaban.amountFen).toBe(155_951); // 1,559.51 元（卡片加班费例 2）
    // 若误用 21.75：会变成 150,000（1,500.00 元），这一行先红。
    expect(jiaban.amountFen).not.toBe(150_000);
  });

  test('加班费缺省仍是 21.75，与年假同值但法源不同——覆盖加班费不影响年假', () => {
    const jiabanDefault = calcOvertimePay({
      monthlyBaseFen: WAGE,
      holidayDays: 1,
      minWageFen: MIN_WAGE,
    });
    expect(jiabanDefault.amountFen).toBe(150_000); // 500.00 × 300%
    // 年假不接受 monthlyWorkDays 这类覆盖：入参快照里的分母恒为 21.75。
    const nianjia = calcAnnualLeavePay({
      cumulativeWorkYears: 3,
      avgMonthlyWageExOvertimeFen: WAGE,
      throughDate: '2026-12-31',
      arrangedDaysThisYear: 0,
      minWageFen: MIN_WAGE,
    });
    expect(nianjia.inputs.monthlyPayDays).toBe(21.75);
  });
});
