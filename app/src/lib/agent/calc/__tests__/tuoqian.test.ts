// app/src/lib/agent/calc/__tests__/tuoqian.test.ts
// 把 knowledge/packs/calc/tuoqian-jiafu-peichang.md 的四个算例钉成回归锚点。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect } from 'vitest';
import { CALC_FLAG, calcArrearsPenalty, type ArrearsItem } from '../index';

/** 例 1 的应付金额：月工资 20,000 × 3 个月 = 60,000.00 元。 */
const ITEMS_60K: ArrearsItem[] = [
  { category: '劳动报酬', label: '2026-03 至 2026-05 工资', amountFen: 6_000_000 },
];

describe('calcArrearsPenalty：卡片算例锚点', () => {
  test('例 1（三步齐备）：60,000 本金 → 加付 30,000~60,000、合计 90,000~120,000 元', () => {
    const r = calcArrearsPenalty({
      items: ITEMS_60K,
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(r.kind).toBe('加付赔偿金');
    expect(r.prerequisiteMet).toBe(true);
    expect(r.principalFen).toBe(6_000_000);
    expect(r.penaltyLowFen).toBe(3_000_000);
    expect(r.penaltyHighFen).toBe(6_000_000);
    expect(r.totalLowFen).toBe(9_000_000);
    expect(r.totalHighFen).toBe(12_000_000);
    // amountFen 取区间下端（保守可主张值），上端另列。
    expect(r.amountFen).toBe(r.penaltyLowFen);
    expect(r.flags).toContain(CALC_FLAG.tuoqianRateDiscretion);
    expect(r.flags).not.toContain(CALC_FLAG.tuoqianPrereqUnmet);
  });

  test('例 2（公司限期内付清——最常见结局）：加付赔偿金 = 0', () => {
    const r = calcArrearsPenalty({
      items: ITEMS_60K,
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: false,
    });
    expect(r.prerequisiteMet).toBe(false);
    expect(r.amountFen).toBe(0);
    expect(r.penaltyLowFen).toBe(0);
    expect(r.penaltyHighFen).toBe(0);
    // 本金仍在，合计两端都等于本金。
    expect(r.totalLowFen).toBe(6_000_000);
    expect(r.totalHighFen).toBe(6_000_000);
    expect(r.flags).toContain(CALC_FLAG.tuoqianPaidWithinDeadline);
    expect(r.flags).toContain(CALC_FLAG.tuoqianPrereqUnmet);
  });

  test('例 3（第 85 条第 4 项，未付经济补偿）：N=125,000 → 加付 62,500~125,000 元', () => {
    const r = calcArrearsPenalty({
      items: [{ category: '经济补偿', label: '工作 4 年 7 个月的 N（5 个月）', amountFen: 12_500_000 }],
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(r.penaltyLowFen).toBe(6_250_000);
    expect(r.penaltyHighFen).toBe(12_500_000);
    expect(r.totalLowFen).toBe(18_750_000);
    expect(r.totalHighFen).toBe(25_000_000);
  });

  test('例 4（待岗压薪差额也算应付金额）：(20,000−1,778)×4 = 72,888 → 加付 36,444~72,888 元', () => {
    const r = calcArrearsPenalty({
      items: [{ category: '劳动报酬', label: '待岗压薪工资差额 4 个月', amountFen: 7_288_800 }],
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(r.principalFen).toBe(7_288_800);
    expect(r.penaltyLowFen).toBe(3_644_400);
    expect(r.penaltyHighFen).toBe(7_288_800);
  });
});

describe('calcArrearsPenalty：三步前置的每一步都能单独把金额打成 0', () => {
  const base = { items: ITEMS_60K, complaintFiled: true, orderIssued: true, overdueUnpaid: true };

  test('没去监察投诉 → 0，且不算「限期内付清」', () => {
    const r = calcArrearsPenalty({ ...base, complaintFiled: false });
    expect(r.amountFen).toBe(0);
    expect(r.flags).toContain(CALC_FLAG.tuoqianPrereqUnmet);
    expect(r.flags).not.toContain(CALC_FLAG.tuoqianPaidWithinDeadline);
  });

  test('监察未下达指令书 → 0', () => {
    const r = calcArrearsPenalty({ ...base, orderIssued: false });
    expect(r.amountFen).toBe(0);
    expect(r.flags).not.toContain(CALC_FLAG.tuoqianPaidWithinDeadline);
  });

  test('只去仲裁不去监察，这 50%—100% 拿不到：恒发行政前置与不可仲裁两个 flag', () => {
    for (const prereq of [true, false]) {
      const r = calcArrearsPenalty({ ...base, complaintFiled: prereq, orderIssued: prereq, overdueUnpaid: prereq });
      expect(r.flags).toContain(CALC_FLAG.tuoqianAdminPrerequisite);
      expect(r.flags).toContain(CALC_FLAG.tuoqianNotArbitrable);
      expect(r.flags).toContain(CALC_FLAG.tuoqianClaimAfterPrincipalPaid);
    }
  });
});

describe('calcArrearsPenalty：应付金额的四类与分项', () => {
  test('四类分项累加成本金，逐项进 steps 供质证；奖金津贴加班费都在范围内', () => {
    const r = calcArrearsPenalty({
      items: [
        { category: '劳动报酬', label: '工资差额', amountFen: 1_000_000 },
        { category: '最低工资差额', label: '低于最低工资部分', amountFen: 50_000 },
        { category: '加班费', label: '2026 年加班费', amountFen: 333_333 },
        { category: '经济补偿', label: 'N', amountFen: 2_000_000 },
      ],
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(r.principalFen).toBe(3_383_333);
    // 50% 出现半分时四舍五入一次。
    expect(r.penaltyLowFen).toBe(1_691_667);
    expect(r.flags).toContain(CALC_FLAG.tuoqianScopeIncludesBonus);
    expect(r.steps.find((s) => s.id === 'principal')?.detail).toContain('加班工资');
  });

  test('比例可覆盖（行政部门裁量落在区间内的具体值）', () => {
    const r = calcArrearsPenalty({
      items: ITEMS_60K,
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
      rateLow: 0.8,
      rateHigh: 0.8,
    });
    expect(r.penaltyLowFen).toBe(4_800_000);
    expect(r.penaltyHighFen).toBe(4_800_000);
    expect(r.formula).toContain('80%~80%');
  });

  test('入参非法直接抛错，不给出一个看似合理的数', () => {
    expect(() => calcArrearsPenalty({ items: [], complaintFiled: true, orderIssued: true, overdueUnpaid: true })).toThrow(
      'items 不能为空',
    );
    expect(() =>
      calcArrearsPenalty({ ...{ items: ITEMS_60K, complaintFiled: true, orderIssued: true, overdueUnpaid: true }, rateLow: 1.2 }),
    ).toThrow('rateLow 不得大于 rateHigh');
  });

  test('basis 挂到第 85 条、北京第 35 条与 534 号第 6 问', () => {
    const r = calcArrearsPenalty({
      items: ITEMS_60K,
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第八十五条', packId: 'calc-tuoqian-jiafu-peichang' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第三十五条', packId: 'calc-tuoqian-jiafu-peichang' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第6问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
  });

  test('inputs 快照已冻结，含归一后的比例与本金', () => {
    const r = calcArrearsPenalty({
      items: ITEMS_60K,
      complaintFiled: true,
      orderIssued: true,
      overdueUnpaid: true,
    });
    expect(Object.isFrozen(r.inputs)).toBe(true);
    expect(r.inputs.rateLow).toBe(0.5);
    expect(r.inputs.rateHigh).toBe(1);
    expect(r.inputs.principalFen).toBe(6_000_000);
  });
});
