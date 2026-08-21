// app/src/lib/agent/calc/__tests__/jingye.test.ts
// 把 knowledge/packs/calc/jingye-buchang-weiyuejin.md 的三个算例钉成回归锚点。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect } from 'vitest';
import {
  CALC_FLAG,
  JINGYE_MAX_MONTHS,
  MIN_WAGE_FEN_DEFAULT,
  calcNonCompeteComp,
} from '../index';

const MIN_WAGE = 254_000;

describe('calcNonCompeteComp：卡片算例锚点', () => {
  // 北京三中院 2026 典型案例·案例四：赵某，W = 17,434.48 元，约定竞业 3 年，
  // 合同写「工资中已含竞业补偿金 10%」。法院实判按 30% 支付离职后两年，共计 12 万余元。
  test('算例 1（真实案例回算）：36 个月封顶 24，30% → M=5,230.34、C=125,528.16 元', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 1_743_448,
      agreedMonths: 36,
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('竞业补偿');
    expect(r.inputs.months).toBe(JINGYE_MAX_MONTHS);
    expect(r.monthlyCompFen).toBe(523_034);
    // 卡片写 125,528.26，那是用未取整的月值 5,230.344 × 24 算的。
    // 补偿按月支付、每月各自到期，本实现按「月值先取整再乘月数」出数 → 125,528.16，差 0.10 元。
    // 两者都落在法院「12 万余元」的表述内；口径见 jingye.ts calcNonCompeteComp 的注释。
    expect(r.totalCompFen).toBe(12_552_816);
    expect(r.amountFen).toBe(r.totalCompFen);
    expect(r.flags).toContain(CALC_FLAG.jingyeTermCapped);
    expect(r.flags).toContain(CALC_FLAG.jingyeRate30Judicable);
    // 「工资中已含竞业补偿金」的约定不能抵扣（指引§16）。
    expect(r.flags).toContain(CALC_FLAG.jingyeWageInclusiveNoOffset);
  });

  test('算例 1 续：T=24 > 12 另给 50% 谈判档，但可主张值仍是 30% 档', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 1_743_448,
      agreedMonths: 36,
      minWageFen: MIN_WAGE,
    });
    expect(r.flags).toContain(CALC_FLAG.jingyeRate50Guideline);
    expect(r.negotiationMonthlyCompFen).toBe(871_724);
    expect(r.negotiationTotalCompFen).toBe(20_921_376);
    // amountFen 不受 50% 档影响——50% 是谈判目标，不是可主张值。
    expect(r.amountFen).toBe(12_552_816);
    expect(r.steps.find((s) => s.id === 'negotiation-50')?.detail).toContain('谈判目标');
  });

  test('算例 2（低薪触底 + 短期限）：M=2,540、C=30,480、P=152,400，违约金 50 万 = 16.4 倍', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 780_000,
      agreedMonths: 12,
      agreedPenaltyFen: 50_000_000,
      minWageFen: MIN_WAGE,
    });
    expect(r.monthlyCompFen).toBe(254_000);
    expect(r.totalCompFen).toBe(3_048_000);
    expect(r.penaltyCapFen).toBe(15_240_000);
    expect(r.penaltyMultiple).toBeCloseTo(16.4, 1);
    expect(r.flags).toContain(CALC_FLAG.jingyeCompMinWageFloor);
    expect(r.flags).toContain(CALC_FLAG.jingyePenaltyOverCap);
    // 未约定补偿总额时 5 倍线的分母是推导来的，不是指引原文。
    expect(r.flags).toContain(CALC_FLAG.jingyePenaltyBaseDerived);
    // T = 12 不超过 12 个月，不出 50% 档。
    expect(r.flags).not.toContain(CALC_FLAG.jingyeRate50Guideline);
    expect(r.negotiationTotalCompFen).toBeUndefined();
  });

  test('算例 2 续：触底分界点 W ≈ 8,467 元', () => {
    const at8466 = calcNonCompeteComp({ avgMonthlyWageFen: 846_600, agreedMonths: 12, minWageFen: MIN_WAGE });
    const at8467 = calcNonCompeteComp({ avgMonthlyWageFen: 846_700, agreedMonths: 12, minWageFen: MIN_WAGE });
    expect(at8466.monthlyCompFen).toBe(MIN_WAGE);
    expect(at8466.flags).toContain(CALC_FLAG.jingyeCompMinWageFloor);
    expect(at8467.monthlyCompFen).toBe(254_010);
    expect(at8467.flags).not.toContain(CALC_FLAG.jingyeCompMinWageFloor);
  });

  test('算例 3（公司中途停付）：约定 50% 高于下限按约定，C=360,000、欠付 300,000、分手费下限 45,000', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 3_000_000,
      agreedMonths: 24,
      agreedMonthlyCompFen: 1_500_000,
      paidCompFen: 6_000_000,
      unpaidMonths: 2,
      writtenDemandSent: true,
      minWageFen: MIN_WAGE,
    });
    expect(r.monthlyCompFen).toBe(1_500_000);
    expect(r.totalCompFen).toBe(36_000_000);
    expect(r.arrearsFen).toBe(30_000_000);
    expect(r.earlyReleaseFloorFen).toBe(4_500_000);
    // 已履行 4 个月后断供，第 5 个月末书面催告，第 6 个月仍未付 → 指引§17 达标。
    expect(r.releaseAvailable).toBe(true);
    expect(r.flags).toContain(CALC_FLAG.jingyeReleaseAvailable);
  });
});

describe('calcNonCompeteComp：停付解套的门槛', () => {
  const base = {
    avgMonthlyWageFen: 3_000_000,
    agreedMonths: 24,
    agreedMonthlyCompFen: 1_500_000,
    minWageFen: MIN_WAGE,
  };

  test('催告过：超 1 个月即可解套，恰好 1 个月还不行', () => {
    expect(calcNonCompeteComp({ ...base, unpaidMonths: 1, writtenDemandSent: true }).releaseAvailable).toBe(false);
    expect(calcNonCompeteComp({ ...base, unpaidMonths: 2, writtenDemandSent: true }).releaseAvailable).toBe(true);
  });

  test('没催告：要等到超 3 个月，第 3 个月末还不行——这一步的成败全在那份书面催告', () => {
    expect(calcNonCompeteComp({ ...base, unpaidMonths: 2 }).releaseAvailable).toBe(false);
    expect(calcNonCompeteComp({ ...base, unpaidMonths: 3 }).releaseAvailable).toBe(false);
    expect(calcNonCompeteComp({ ...base, unpaidMonths: 4 }).releaseAvailable).toBe(true);
  });

  test('缺省未停付：不解套，不打 flag', () => {
    const r = calcNonCompeteComp(base);
    expect(r.releaseAvailable).toBe(false);
    expect(r.flags).not.toContain(CALC_FLAG.jingyeReleaseAvailable);
    expect(r.arrearsFen).toBeUndefined();
  });
});

describe('calcNonCompeteComp：分支与边界', () => {
  test('条款不生效：补偿与违约金一并归零，且视为无须履行', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 3_000_000,
      agreedMonths: 24,
      agreedPenaltyFen: 50_000_000,
      clauseEffective: false,
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(0);
    expect(r.totalCompFen).toBe(0);
    expect(r.penaltyCapFen).toBe(0);
    expect(r.earlyReleaseFloorFen).toBe(0);
    expect(r.releaseAvailable).toBe(true);
    expect(r.flags).toContain(CALC_FLAG.jingyeClauseIneffective);
  });

  test('实际履行短于约定的按实际计（已过的月份按实际履行）', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 2_000_000,
      agreedMonths: 24,
      actualMonths: 6,
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.months).toBe(6);
    expect(r.monthlyCompFen).toBe(600_000);
    expect(r.totalCompFen).toBe(3_600_000);
    expect(r.flags).not.toContain(CALC_FLAG.jingyeRate50Guideline);
  });

  test('实际履行长于约定的仍按约定（孰短），且约定本身先受 24 个月封顶', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 2_000_000,
      agreedMonths: 36,
      actualMonths: 30,
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.months).toBe(24);
    expect(r.flags).toContain(CALC_FLAG.jingyeTermCapped);
  });

  test('约定了补偿总额的，5 倍线用约定总额作分母（指引§14 原文口径）', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 780_000,
      agreedMonths: 12,
      agreedTotalCompFen: 2_000_000,
      agreedPenaltyFen: 9_000_000,
      minWageFen: MIN_WAGE,
    });
    expect(r.penaltyCapFen).toBe(10_000_000);
    expect(r.flags).not.toContain(CALC_FLAG.jingyePenaltyBaseDerived);
    // 90,000 元违约金未超 100,000 元的 5 倍线。
    expect(r.flags).not.toContain(CALC_FLAG.jingyePenaltyOverCap);
  });

  test('约定月补偿低于 30% 下限的按下限补足，不按约定', () => {
    const r = calcNonCompeteComp({
      avgMonthlyWageFen: 2_000_000,
      agreedMonths: 12,
      agreedMonthlyCompFen: 300_000,
      minWageFen: MIN_WAGE,
    });
    expect(r.monthlyCompFen).toBe(600_000);
  });

  test('5 倍线始终标注为参考标尺，不是裁判规则', () => {
    const r = calcNonCompeteComp({ avgMonthlyWageFen: 2_000_000, agreedMonths: 12, minWageFen: MIN_WAGE });
    expect(r.flags).toContain(CALC_FLAG.jingyePenaltyCapAdvisory);
  });

  test('未给最低工资时用内置缺省并打「待核实」', () => {
    const r = calcNonCompeteComp({ avgMonthlyWageFen: 780_000, agreedMonths: 12 });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('入参非法直接抛错', () => {
    expect(() => calcNonCompeteComp({ avgMonthlyWageFen: 2_000_000, agreedMonths: 0 })).toThrow(
      'agreedMonths 必须为正数',
    );
    expect(() =>
      calcNonCompeteComp({ avgMonthlyWageFen: 2_000_000, agreedMonths: 12, actualMonths: -1 }),
    ).toThrow('actualMonths 不得为负');
  });

  test('basis 挂到劳动合同法§24、法释〔2020〕26号§36 与人社部指引（标明行政指引）', () => {
    const r = calcNonCompeteComp({ avgMonthlyWageFen: 2_000_000, agreedMonths: 12, minWageFen: MIN_WAGE });
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第三十六条', packId: 'calc-jingye-buchang-weiyuejin' }),
    );
    expect(r.basis.find((b) => b.packId === 'statute-rsty-2025-40-jingye-zhiyin')?.law).toContain(
      '行政指引，非裁判规则',
    );
    expect(Object.isFrozen(r.inputs)).toBe(true);
  });
});
