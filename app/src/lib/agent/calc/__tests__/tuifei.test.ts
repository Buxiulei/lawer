// app/src/lib/agent/calc/__tests__/tuifei.test.ts
// 退费测算的判据（设计稿 §16「退费与违约金：合同约定 / 未完成次数比例 / 消保法 55 条三倍风险测算」）。
//
// 【这一组判据真正要拦的两件事】
//  ① **三条口径被折成一个数**：合同定性（委托 vs 服务）未定，SOP 卡第 3 步写的是
//     「给区间 + 两条算法的分别结果 + 差异原因，不是一个数」。折成一个数的形态是——
//     用户拿着那个数去谈，而它背后是我们替律师做的一次定性。
//  ② **三倍赔偿被当成结论、被并进总额**：§55 的前提是认定欺诈行为、举证在对方。
//     并进总额的形态是——我们算出来的数字，替对方把主张抬高了一截。
import { describe, expect, it } from 'vitest';

import { XBF_PUNITIVE_FLOOR_FEN, calcRefund } from '../tuifei';

/** 一份标准算例：付 12000 元买 20 次（单次 600 元，无折扣），已做 8 次。 */
const PLAIN = {
  totalPaidFen: 1_200_000,
  sessionsTotal: 20,
  sessionsUsed: 8,
  unitPriceFen: 60_000,
};

/** 打包价算例：单次标价 800 元、20 次打包只收 12000 元（均价 600），已做 8 次。 */
const PACKAGE = {
  totalPaidFen: 1_200_000,
  sessionsTotal: 20,
  sessionsUsed: 8,
  unitPriceFen: 80_000,
};

describe('退费：三种口径各自出数（设计稿 §16）', () => {
  it('无折扣时：未完成比例法与已提供服务对价法同数，合同未约定则第三条不出数', () => {
    const r = calcRefund(PLAIN);
    // 12000 × 12/20 = 7200
    expect(r.byUnusedRatioFen).toBe(720_000);
    // 12000 − 8×600 = 7200
    expect(r.byDeliveredValueFen).toBe(720_000);
    // 「未约定」不是「约定退 0」：这一条必须是 null，不是 0
    expect(r.byContractFen).toBeNull();
    expect(r.flags).toContain('合同无可算退费条款，按约定那条口径不出数');
  });

  it('口径一「概不退费」：按字面退 0，但同时给出条款可能无效那条 flag', () => {
    const r = calcRefund({ ...PLAIN, clause: { kind: '概不退费' } });
    expect(r.byContractFen).toBe(0);
    expect(r.flags).toContain('「概不退费」条款有被认定无效的风险（消保法§26第三款）');
    // 0 只是区间的下限，不是结论——区间上限仍是另外两条口径给的 7200
    expect(r.rangeLowFen).toBe(0);
    expect(r.rangeHighFen).toBe(720_000);
  });

  it('口径一「按比例扣违约金」：剩余部分扣 20% ⇒ 7200 × 80% = 5760', () => {
    const r = calcRefund({ ...PLAIN, clause: { kind: '按比例扣违约金', rateBp: 2000 } });
    expect(r.byContractFen).toBe(576_000);
    expect(r.rangeLowFen).toBe(576_000);
    expect(r.rangeHighFen).toBe(720_000);
  });

  it('口径一「扣固定违约金」：扣光为止不倒扣', () => {
    expect(calcRefund({ ...PLAIN, clause: { kind: '扣固定违约金', penaltyFen: 200_000 } }).byContractFen).toBe(
      520_000,
    );
    // 违约金比剩余还多：退 0，不出现负数（负数会被上游当成"倒找钱"）
    expect(calcRefund({ ...PLAIN, clause: { kind: '扣固定违约金', penaltyFen: 99_999_999 } }).byContractFen).toBe(0);
  });

  it('打包折扣时两条算法必然分叉，且差额被算出来讲清（变异：把单次价改成用均价 → 分叉消失、本条红）', () => {
    const r = calcRefund(PACKAGE);
    // 按未完成比例：12000 × 12/20 = 7200（折扣双方共担）
    expect(r.byUnusedRatioFen).toBe(720_000);
    // 按已提供服务对价：12000 − 8×800 = 5600（折扣留给我方）
    expect(r.byDeliveredValueFen).toBe(560_000);
    expect(r.byUnusedRatioFen).not.toBe(r.byDeliveredValueFen);
    expect(r.flags).toContain('打包价与单次价不一致，两条算法有差额');
    const step = r.steps.find((s) => s.id === 'by-delivered-value')!;
    expect(step.detail, '差额没被算出来，用户只看到两个不一样的数').toContain('1,600.00'); // |7200−5600|
  });
});

describe('退费：给区间，不给单一数字', () => {
  it('amountFen 落的是区间上限（对我方最不利的那一端），formula 里给的是整个区间', () => {
    const r = calcRefund({ ...PACKAGE, clause: { kind: '概不退费' } });
    expect(r.rangeLowFen).toBe(0);
    expect(r.rangeHighFen).toBe(720_000);
    expect(r.amountFen).toBe(r.rangeHighFen);
    expect(r.formula).toContain('退费区间');
    expect(r.formula).toContain('—'); // 区间是两端，不是一个数
    expect(r.flags).toContain('退费给区间不给单一数字（合同定性未定）');
    expect(r.flags).toContain('合同定性（委托/服务）未经律师书面确认');
  });

  it('区间的两端确实来自那几条口径（变异：把 rangeHigh 写死成某一条 → 红）', () => {
    const r = calcRefund({ ...PACKAGE, clause: { kind: '按比例扣违约金', rateBp: 5000 } });
    const lines = [r.byUnusedRatioFen, r.byDeliveredValueFen, r.byContractFen!];
    expect(r.rangeLowFen).toBe(Math.min(...lines));
    expect(r.rangeHighFen).toBe(Math.max(...lines));
  });
});

describe('退费：消保法 §55 三倍只出风险区间，不出结论', () => {
  it('三倍是区间不是一个数，且不并进退费金额（变异：把 punitive 加进 amountFen → 红）', () => {
    const r = calcRefund(PLAIN);
    // 缺省基数区间 = [未完成比例法 7200, 已付 12000] ⇒ ×3 = [21600, 36000]
    expect(r.punitiveRisk.lowFen).toBe(2_160_000);
    expect(r.punitiveRisk.highFen).toBe(3_600_000);
    expect(r.punitiveRisk.lowFen).not.toBe(r.punitiveRisk.highFen);
    // 关键：一分钱都没进退费
    expect(r.amountFen).toBe(r.rangeHighFen);
    expect(r.amountFen).toBeLessThan(r.punitiveRisk.lowFen);
    expect(r.rangeHighFen).toBe(720_000);
  });

  it('那句纪律逐字在场：是风险测算、不是结论、不计入退费、举证在对方', () => {
    const r = calcRefund(PLAIN);
    for (const phrase of ['风险测算', '不是结论', '欺诈', '举证责任在对方', '不计入退费金额']) {
      expect(r.punitiveRisk.note, `三倍那段少了「${phrase}」`).toContain(phrase);
    }
    expect(r.flags).toContain('三倍赔偿是风险区间不是结论（须先认定欺诈，举证在对方）');
  });

  it('不足五百元按五百元（§55 第一款下限），并打 flag', () => {
    // 付 100 元买 2 次已做 1 次 ⇒ 基数区间 [50, 100] ×3 = [150, 300]，两端都不足 500
    const r = calcRefund({ totalPaidFen: 10_000, sessionsTotal: 2, sessionsUsed: 1, unitPriceFen: 5_000 });
    expect(r.punitiveRisk.lowFen).toBe(XBF_PUNITIVE_FLOOR_FEN);
    expect(r.punitiveRisk.highFen).toBe(XBF_PUNITIVE_FLOOR_FEN);
    expect(r.punitiveRisk.floorApplied).toBe(true);
    expect(r.flags).toContain('三倍不足五百元按五百元（消保法§55第一款）');
  });

  it('基数区间可由调用方指定（涉欺诈的只是某一段时）', () => {
    const r = calcRefund({ ...PLAIN, punitiveBaseLowFen: 100_000, punitiveBaseHighFen: 300_000 });
    expect(r.punitiveRisk.lowFen).toBe(300_000);
    expect(r.punitiveRisk.highFen).toBe(900_000);
  });
});

describe('退费：自洽性由入参把关，不静默兜底成一个看起来正常的数', () => {
  it('已完成次数多于约定总次数 ⇒ 抛，并说清是哪两个数打架', () => {
    expect(() => calcRefund({ ...PLAIN, sessionsUsed: 21 })).toThrow(/已完成次数 21 超过约定总次数 20/);
  });

  it('总次数为 0 或负 ⇒ 抛（否则比例法要除以 0）', () => {
    expect(() => calcRefund({ ...PLAIN, sessionsTotal: 0 })).toThrow(/正整数/);
  });

  it('一次都没做：全额进区间上限', () => {
    const r = calcRefund({ ...PLAIN, sessionsUsed: 0 });
    expect(r.byUnusedRatioFen).toBe(1_200_000);
    expect(r.byDeliveredValueFen).toBe(1_200_000);
    expect(r.rangeHighFen).toBe(1_200_000);
  });

  it('全部做完：退费为 0，但三倍风险区间照旧存在（做完了不等于没有欺诈争议）', () => {
    const r = calcRefund({ ...PLAIN, sessionsUsed: 20 });
    expect(r.rangeHighFen).toBe(0);
    expect(r.punitiveRisk.highFen).toBe(3_600_000);
  });

  it('依据挂到条号与来源卡（变异：删掉 §55 那条 basis → 红）', () => {
    const r = calcRefund(PLAIN);
    const arts = r.basis.map((b) => `${b.law}${b.article}`);
    expect(arts.some((a) => a.includes('第五十五条'))).toBe(true);
    expect(arts.some((a) => a.includes('第二十六条'))).toBe(true);
    expect(arts.some((a) => a.includes('第九百三十三条'))).toBe(true);
    for (const b of r.basis) expect(b.packId, `${b.article} 没挂来源卡`).toBeTruthy();
  });
});
