// app/src/lib/agent/calc/__tests__/jingji-buchang.test.ts
// 把 knowledge/packs/calc/jingji-buchang-n.md 的三个算例钉成回归锚点，外加每个分支一条用例。
// 这些数字是要拿到庭上的：口径改了必须先改知识卡、再改这里的锚点，不许反过来「改测试让它过」。
import { describe, test, expect, afterEach } from 'vitest';
import { fromSql } from '@/lib/db/time';
import {
  CALC_FLAG,
  CALC_VERSION,
  MIN_WAGE_FEN_DEFAULT,
  SANBEI_CAP_FEN_DEFAULT,
  calc2N,
  calcN,
  calcNPlus1,
  tenureToMonths,
} from '../index';

/** 三倍封顶 47,103.25 元/月。显式传入以隔离「用了缺省就打 flag」的噪声。 */
const CAP = 4_710_325;
const MIN_WAGE = 254_000;
const withDefaults = { sanbeiCapFen: CAP, minWageFen: MIN_WAGE };

describe('tenureToMonths：工作年限折算（第四十七条第一款）', () => {
  test('N 卡例 1：4 年 7 个月 → 5（余 7 个月满六个月按一年）', () => {
    expect(tenureToMonths('2021-01-01', '2025-08-01')).toBe(5);
  });

  test('4 年 5 个月 → 4.5（余 5 个月不满六个月按半月）', () => {
    expect(tenureToMonths('2021-01-01', '2025-06-01')).toBe(4.5);
  });

  test('入职 5 个月 → 0.5', () => {
    expect(tenureToMonths('2026-01-01', '2026-06-01')).toBe(0.5);
  });

  test('恰满 6 个月 → 1（属「六个月以上不满一年」档，不是 0.5）', () => {
    expect(tenureToMonths('2026-01-01', '2026-07-01')).toBe(1);
  });

  test('差一天不满 6 个月 → 0.5', () => {
    expect(tenureToMonths('2026-01-01', '2026-06-30')).toBe(0.5);
  });

  test('恰满整年无余数 → 不加档', () => {
    expect(tenureToMonths('2020-03-15', '2023-03-15')).toBe(3);
    expect(tenureToMonths('2020-03-15', '2023-03-16')).toBe(3.5);
  });

  test('同日入职同日解除 → 0', () => {
    expect(tenureToMonths('2026-08-19', '2026-08-19')).toBe(0);
  });

  test('canonical / ISO 串只取日期部分', () => {
    expect(tenureToMonths('2021-01-01 08:30:00', '2025-08-01T23:59:59.000Z')).toBe(5);
  });

  test('月末入职按自然月截取，不跨出目标月（1-31 加一个月 = 2-28）', () => {
    expect(tenureToMonths('2021-01-31', '2021-07-31')).toBe(1);
    expect(tenureToMonths('2021-01-31', '2021-03-01')).toBe(0.5);
  });

  test('闰日入职', () => {
    expect(tenureToMonths('2020-02-29', '2021-02-28')).toBe(1);
  });

  test('非法输入抛错', () => {
    expect(() => tenureToMonths('2026-08-01', '2026-07-31')).toThrow(/晚于/);
    expect(() => tenureToMonths('2026-02-30', '2026-08-01')).toThrow(/不是真实存在的日期/);
    expect(() => tenureToMonths('2026-13-01', '2026-08-01')).toThrow(/不是真实存在的日期/);
    expect(() => tenureToMonths('2026/08/01', '2026-08-01')).toThrow(/不是合法日期串/);
    expect(() => tenureToMonths('2026-08-01', '昨天')).toThrow(/不是合法日期串/);
  });
});

describe('日期解析一律走 fromSql（ADR-002：canonical 串按 UTC 解析）', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 恰满 6 个月的边界：入职 01-01 16:00、解除 07-01 00:00。挑这一对是因为它对时区漂移最敏感——
  // 解除日一旦被退到 06-30，工龄就从「恰满六个月」掉进「不满六个月」，补偿月数由 1 变 0.5。
  const CANONICAL: [string, string] = ['2020-01-01 16:00:00', '2020-07-01 00:00:00'];
  const ISO: [string, string] = ['2020-01-01T16:00:00Z', '2020-07-01T00:00:00Z'];
  const TZS = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  test.each(TZS)('TZ=%s：带时间的 canonical 串与 ISO Z 串算出同一档（恰满 6 个月 → 1）', (tz) => {
    process.env.TZ = tz;
    expect(tenureToMonths(...CANONICAL)).toBe(1);
    expect(tenureToMonths(...ISO)).toBe(1);
    expect(tenureToMonths(...CANONICAL)).toBe(tenureToMonths(...ISO));
  });

  test.each(TZS)('TZ=%s：金额不随本机时区漂移', (tz) => {
    process.env.TZ = tz;
    const wage = { avgMonthlyWageFen: 2_000_000, ...withDefaults };
    const [employedFrom, terminatedAt] = CANONICAL;
    const [isoFrom, isoTo] = ISO;
    expect(calcN({ ...wage, employedFrom, terminatedAt }).amountFen).toBe(2_000_000);
    expect(calcN({ ...wage, employedFrom: isoFrom, terminatedAt: isoTo }).amountFen).toBe(2_000_000);
  });

  test('时区陷阱是真的：裸 new Date 解析 canonical 串在 UTC+8 下退到前一天，fromSql 不会', () => {
    process.env.TZ = 'Asia/Shanghai';
    const terminatedAt = CANONICAL[1];
    expect(new Date(terminatedAt).toISOString().slice(0, 10)).toBe('2020-06-30');
    expect(fromSql(terminatedAt).toISOString().slice(0, 10)).toBe('2020-07-01');
  });

  test('inputs 快照里的日期归一成 YYYY-MM-DD，与 UTC 日期一致', () => {
    process.env.TZ = 'Asia/Shanghai';
    const r = calcN({
      avgMonthlyWageFen: 2_000_000,
      employedFrom: CANONICAL[0],
      terminatedAt: ISO[1],
      ...withDefaults,
    });
    expect(r.inputs.employedFrom).toBe('2020-01-01');
    expect(r.inputs.terminatedAt).toBe('2020-07-01');
  });

  test('显式数字时区偏移不收（归一按 UTC 会静默差一天）', () => {
    expect(() => tenureToMonths('2020-01-01T16:00:00+08:00', '2020-07-01')).toThrow(
      /不是合法日期串/,
    );
  });
});

describe('calcN：N 卡算例锚点', () => {
  test('例 1（普通）：月均 2 万 × 4 年 7 个月 = 100,000.00 元', () => {
    const r = calcN({
      avgMonthlyWageFen: 2_000_000,
      employedFrom: '2021-01-01',
      terminatedAt: '2025-08-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(10_000_000);
    expect(r.formula).toBe('20,000.00 × 5 = 100,000.00 元');
    expect(r.kind).toBe('N');
    expect(r.flags).toEqual([CALC_FLAG.roundUpYear]);
  });

  test('例 2 对照组（恰好等于封顶，不触发封顶）：47,103.25 × 15.5 = 730,100.38 元', () => {
    const r = calcN({
      avgMonthlyWageFen: CAP,
      employedFrom: '2010-01-01',
      terminatedAt: '2025-04-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(73_010_038);
    expect(r.formula).toBe('47,103.25 × 15.5 = 730,100.38 元');
    expect(r.flags).not.toContain(CALC_FLAG.twelveYearCap);
    expect(r.flags).not.toContain(CALC_FLAG.sanbeiCliff);
  });

  test('例 2 断崖组（略超封顶）：47,103.25 × 12 = 565,239.00 元，两限捆绑', () => {
    const r = calcN({
      avgMonthlyWageFen: 4_720_000,
      employedFrom: '2010-01-01',
      terminatedAt: '2025-04-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(56_523_900);
    expect(r.formula).toBe('47,103.25 × 12 = 565,239.00 元（三倍封顶+12年上限）');
    expect(r.flags).toContain(CALC_FLAG.twelveYearCap);
    expect(r.flags).toContain(CALC_FLAG.sanbeiCliff);
  });

  test('断崖成立：工资涨 968.75 元/月，N 反而少拿 164,861.38 元', () => {
    const base = { employedFrom: '2010-01-01', terminatedAt: '2025-04-01', ...withDefaults };
    const atCap = calcN({ avgMonthlyWageFen: CAP, ...base });
    const overCap = calcN({ avgMonthlyWageFen: 4_720_000, ...base });
    expect(overCap.amountFen).toBeLessThan(atCap.amountFen);
    expect(atCap.amountFen - overCap.amountFen).toBe(16_486_138);
  });

  test('例 3（不满六个月）：1.5 万 × 0.5 = 7,500.00 元', () => {
    const r = calcN({
      avgMonthlyWageFen: 1_500_000,
      employedFrom: '2026-01-01',
      terminatedAt: '2026-06-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(750_000);
    expect(r.formula).toBe('15,000.00 × 0.5 = 7,500.00 元');
    expect(r.flags).toContain(CALC_FLAG.halfMonth);
  });
});

describe('calcN：基数判定分支', () => {
  test('工龄 > 12 年但工资未超封顶 → 月数不封 12', () => {
    const r = calcN({
      avgMonthlyWageFen: 3_000_000,
      employedFrom: '2010-01-01',
      terminatedAt: '2025-04-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(46_500_000); // 30,000 × 15.5
    expect(r.flags).not.toContain(CALC_FLAG.twelveYearCap);
  });

  test('工资超封顶但工龄 ≤ 12 年 → 只压基数，不打 12 年上限/断崖 flag', () => {
    const r = calcN({
      avgMonthlyWageFen: 6_000_000,
      employedFrom: '2020-01-01',
      terminatedAt: '2025-01-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(23_551_625); // 47,103.25 × 5
    expect(r.formula).toBe('47,103.25 × 5 = 235,516.25 元（三倍封顶）');
    expect(r.flags).not.toContain(CALC_FLAG.twelveYearCap);
    expect(r.flags).not.toContain(CALC_FLAG.sanbeiCliff);
  });

  test('平均工资 2,000 < 最低工资 2,540 → 按 2,540 兜底', () => {
    const r = calcN({
      avgMonthlyWageFen: 200_000,
      employedFrom: '2022-01-01',
      terminatedAt: '2025-01-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(762_000); // 2,540 × 3
    expect(r.formula).toBe('2,540.00 × 3 = 7,620.00 元（最低工资兜底）');
    expect(r.flags).toContain(CALC_FLAG.minWageFloor);
  });

  test('恰好等于最低工资 → 不兜底', () => {
    const r = calcN({
      avgMonthlyWageFen: MIN_WAGE,
      employedFrom: '2022-01-01',
      terminatedAt: '2025-01-01',
      ...withDefaults,
    });
    expect(r.amountFen).toBe(762_000);
    expect(r.flags).not.toContain(CALC_FLAG.minWageFloor);
  });

  test('未传封顶值 → 用内置缺省并打「社平新值待核实」', () => {
    const r = calcN({
      avgMonthlyWageFen: 2_000_000,
      employedFrom: '2021-01-01',
      terminatedAt: '2025-08-01',
    });
    expect(r.inputs.sanbeiCapFen).toBe(SANBEI_CAP_FEN_DEFAULT);
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.capUnverified);
  });

  test('传了封顶值 → 不打「社平新值待核实」，且缺省值可被覆盖', () => {
    const r = calcN({
      avgMonthlyWageFen: 5_000_000,
      employedFrom: '2021-01-01',
      terminatedAt: '2024-01-01',
      sanbeiCapFen: 6_000_000,
      minWageFen: MIN_WAGE,
    });
    expect(r.flags).not.toContain(CALC_FLAG.capUnverified);
    expect(r.amountFen).toBe(15_000_000); // 未超新封顶，按实际工资 50,000 × 3
  });

  test('内置缺省常量与知识卡数值一致', () => {
    expect(SANBEI_CAP_FEN_DEFAULT).toBe(4_710_325);
    expect(MIN_WAGE_FEN_DEFAULT).toBe(254_000);
  });
});

describe('calcNPlus1：+1 按上一个月工资，不是 12 个月平均', () => {
  const input = {
    avgMonthlyWageFen: 3_000_000,
    lastMonthWageFen: 1_500_000,
    employedFrom: '2023-06-01',
    terminatedAt: '2026-01-01',
    ...withDefaults,
  };

  test('N+1 卡例 2：平均 3 万、上月 1.5 万、2 年 7 个月 → 90,000 + 15,000 = 105,000 元', () => {
    const r = calcNPlus1(input);
    expect(r.kind).toBe('N+1');
    expect(r.amountFen).toBe(10_500_000);
    expect(r.formula).toBe('30,000.00 × 3 + 15,000.00（上月工资） = 105,000.00 元');
  });

  test('「+1」用上月工资而非平均工资：换掉上月工资，总额只动那一格', () => {
    const low = calcNPlus1(input);
    const high = calcNPlus1({ ...input, lastMonthWageFen: 4_000_000 });
    expect(high.amountFen - low.amountFen).toBe(2_500_000);
    // 若误用平均工资，两者会相等（都是 30,000）。
    expect(low.amountFen).not.toBe(high.amountFen);
    expect(low.amountFen).toBe(calcN(input).amountFen + 1_500_000);
  });

  test('N 部分与 +1 部分分开列 step', () => {
    const r = calcNPlus1(input);
    const ids = r.steps.map((s) => s.id);
    expect(ids).toEqual(['tenure', 'base', 'amount', 'daitongzhijin', 'total']);
    expect(r.steps.find((s) => s.id === 'amount')?.valueFen).toBe(9_000_000);
    expect(r.steps.find((s) => s.id === 'daitongzhijin')?.valueFen).toBe(1_500_000);
    expect(r.steps.find((s) => s.id === 'total')?.valueFen).toBe(10_500_000);
  });

  test('「+1」不受三倍封顶约束（封顶只约束经济补偿）', () => {
    const r = calcNPlus1({ ...input, lastMonthWageFen: 9_000_000 });
    expect(r.amountFen).toBe(9_000_000 + 9_000_000);
  });

  test('basis 含第四十条与实施条例第二十条', () => {
    const r = calcNPlus1(input);
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第四十条', packId: 'calc-daitongzhijin-n1' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第二十条', packId: 'calc-daitongzhijin-n1' }),
    );
  });

  test('inputs 快照带上上月工资', () => {
    expect(calcNPlus1(input).inputs.lastMonthWageFen).toBe(1_500_000);
  });
});

describe('calc2N：违法解除赔偿金', () => {
  const cases = [
    { avgMonthlyWageFen: 2_000_000, employedFrom: '2021-01-01', terminatedAt: '2025-08-01' },
    { avgMonthlyWageFen: CAP, employedFrom: '2010-01-01', terminatedAt: '2025-04-01' },
    { avgMonthlyWageFen: 4_720_000, employedFrom: '2010-01-01', terminatedAt: '2025-04-01' },
    { avgMonthlyWageFen: 200_000, employedFrom: '2022-01-01', terminatedAt: '2025-01-01' },
  ];

  test('恒等于同输入 calcN 的两倍（不分段）', () => {
    for (const c of cases) {
      const input = { ...c, ...withDefaults };
      expect(calc2N(input).amountFen).toBe(calcN(input).amountFen * 2);
    }
  });

  test('flags 从 N 透传', () => {
    for (const c of cases) {
      const input = { ...c, ...withDefaults };
      expect(calc2N(input).flags).toEqual(calcN(input).flags);
    }
  });

  test('断崖组：730,100.38 × 2 = 1,460,200.76 元', () => {
    const r = calc2N({ ...cases[1], ...withDefaults });
    expect(r.kind).toBe('2N');
    expect(r.amountFen).toBe(146_020_076);
    expect(r.formula).toBe('（47,103.25 × 15.5）× 2 = 1,460,200.76 元');
  });

  test('basis 含 §87 / 实施条例 §25 / 534 号第 66 问', () => {
    const r = calc2N({ ...cases[0], ...withDefaults });
    expect(r.basis).toContainEqual(expect.objectContaining({ article: '第八十七条' }));
    expect(r.basis).toContainEqual(expect.objectContaining({ article: '第二十五条' }));
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第66问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
  });

  test('末步是 ×2 留痕', () => {
    const r = calc2N({ ...cases[0], ...withDefaults });
    expect(r.steps.at(-1)).toMatchObject({ id: 'double', valueFen: 20_000_000 });
  });
});

describe('calc_json 契约通用项', () => {
  const input = {
    avgMonthlyWageFen: 2_000_000,
    lastMonthWageFen: 2_500_000,
    employedFrom: '2021-01-01 09:00:00',
    terminatedAt: '2025-08-01',
    ...withDefaults,
    inputSources: {
      avgMonthlyWageFen: '证据佐证',
      employedFrom: '用户自述',
      sanbeiCapFen: '系统默认',
    } as const,
  };
  const results = [calcN(input), calcNPlus1(input), calc2N(input)];

  test('inputs 是归一化后的快照且已冻结', () => {
    for (const r of results) {
      expect(r.inputs).toMatchObject({
        avgMonthlyWageFen: 2_000_000,
        employedFrom: '2021-01-01', // 时间部分被截掉
        terminatedAt: '2025-08-01',
        sanbeiCapFen: CAP,
        minWageFen: MIN_WAGE,
      });
      expect(Object.isFrozen(r.inputs)).toBe(true);
    }
  });

  test('inputSources 原样透传', () => {
    for (const r of results) {
      expect(r.inputSources).toEqual(input.inputSources);
    }
    expect(calcN({ ...input, inputSources: undefined }).inputSources).toBeUndefined();
  });

  test('calcVersion 存在且为 semver', () => {
    for (const r of results) {
      expect(r.calcVersion).toBe(CALC_VERSION);
      expect(r.calcVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(CALC_VERSION).toBe('1.0.0');
  });

  test('steps 非空、id 唯一、detail 可读', () => {
    for (const r of results) {
      expect(r.steps.length).toBeGreaterThanOrEqual(3);
      expect(new Set(r.steps.map((s) => s.id)).size).toBe(r.steps.length);
      for (const s of r.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.detail.length).toBeGreaterThan(10);
      }
    }
  });

  test('basis 非空且每条都带 law/article', () => {
    for (const r of results) {
      expect(r.basis.length).toBeGreaterThan(0);
      for (const b of r.basis) {
        expect(b.law.length).toBeGreaterThan(0);
        expect(b.article.length).toBeGreaterThan(0);
      }
    }
    expect(calcN(input).basis).toContainEqual(
      expect.objectContaining({ article: '第四十七条', packId: 'calc-jingji-buchang-n' }),
    );
    expect(calcN(input).basis).toContainEqual(
      expect.objectContaining({ article: '第55问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
  });

  test('formula 末尾金额与 amountFen 一致', () => {
    for (const r of results) {
      const shown = /= ([\d,]+\.\d{2}) 元/.exec(r.formula);
      expect(shown).not.toBeNull();
      expect(Math.round(Number(shown![1].replace(/,/g, '')) * 100)).toBe(r.amountFen);
    }
  });

  test('金额一律整数分', () => {
    for (const r of results) {
      expect(Number.isInteger(r.amountFen)).toBe(true);
      for (const s of r.steps) {
        if (s.valueFen !== undefined) expect(Number.isInteger(s.valueFen)).toBe(true);
      }
    }
  });

  test('同输入恒同输出（纯函数）', () => {
    expect(calcN(input)).toEqual(calcN(input));
    expect(calcNPlus1(input)).toEqual(calcNPlus1(input));
    expect(calc2N(input)).toEqual(calc2N(input));
  });

  test('非法输入经三个公式一致抛错', () => {
    const bad = { ...input, employedFrom: '2026-01-01', terminatedAt: '2025-01-01' };
    expect(() => calcN(bad)).toThrow(/晚于/);
    expect(() => calcNPlus1(bad)).toThrow(/晚于/);
    expect(() => calc2N(bad)).toThrow(/晚于/);

    const badDate = { ...input, employedFrom: '2025-02-29' };
    expect(() => calcN(badDate)).toThrow(/不是真实存在的日期/);
    expect(() => calcNPlus1(badDate)).toThrow(/不是真实存在的日期/);
    expect(() => calc2N(badDate)).toThrow(/不是真实存在的日期/);
  });
});
