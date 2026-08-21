// app/src/lib/agent/calc/__tests__/shuangbei.test.ts
// 把 knowledge/packs/calc/weiqian-hetong-shuangbei.md 的四个算例钉成回归锚点；
// 三情形的起止与上限以 statutes/jgf-2024-534-jieda-1.md 第 41 问逐字原文为准。
// 口径改了必须先改知识卡、再改这里的锚点。
import { describe, test, expect, afterEach } from 'vitest';
import {
  CALC_FLAG,
  MIN_WAGE_FEN_DEFAULT,
  SHUANGBEI_MONTHLY_PAY_DAYS_DEFAULT,
  calcDoubleWage,
  type DoubleWageMonth,
} from '../index';

const MIN_WAGE = 254_000;
const W12000 = 1_200_000;
/** 月工资 10,875 元 → 日工资恰好 500 元（÷21.75），卡片例 3 用的就是这个数。 */
const W10875 = 1_087_500;

/** 生成连续月份的等额工资明细。 */
function months(from: string, count: number, wageFen: number): DoubleWageMonth[] {
  const [y0, m0] = from.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const total = (y0 * 12 + (m0 - 1) + i) as number;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return { month: `${y}-${String(m).padStart(2, '0')}`, wageFen };
  });
}

describe('calcDoubleWage：卡片算例锚点', () => {
  test('例 1（中途补签）：2025-09-01 入职、2026-02-01 补签 → 4 个整月 = 48,000.00 元', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-09-01',
      contractSignedAt: '2026-02-01',
      claimedAt: '2026-02-01',
      months: months('2025-10', 4, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.kind).toBe('双倍工资');
    expect(r.amountFen).toBe(4_800_000);
    expect(r.claimableFen).toBe(4_800_000);
    expect(r.expiredFen).toBe(0);
    expect(r.inputs.windowFrom).toBe('2025-10-01'); // 用工满一个月的次日
    expect(r.inputs.windowTo).toBe('2026-01-31'); // 补签前一日
    expect(r.formula).toBe(
      '2025-10-01 至 2026-01-31 共 4 个计算月：Σ（各月应付工资 × 1）= 48,000.00 元',
    );
  });

  test('例 2（11 个月封顶 + 满一年归零）：2025-03-01 入职始终未签 → 132,000.00 元', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-03-01',
      claimedAt: '2026-03-01',
      months: months('2025-04', 11, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(13_200_000);
    expect(r.inputs.windowFrom).toBe('2025-04-01');
    expect(r.inputs.windowTo).toBe('2026-02-28'); // 用工满一年之日，恰好也是 11 个月上限
    expect(r.steps.filter((s) => s.id.startsWith('month-'))).toHaveLength(11);
  });

  test('例 2 续：再主张满一年后的 2026-03 → 该月被排除，金额不变', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-03-01',
      claimedAt: '2026-04-01',
      months: months('2025-04', 12, W12000), // 多给一个 2026-03
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(13_200_000);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiOneYearBlock);
    expect(r.steps.find((s) => s.id === 'one-year-block')?.detail).toContain('2026-03');
  });

  test('例 3（不满一月按实际工作日折算）：日工资 500 × (13+21) 天 = 17,000.00 元', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2026-01-10',
      contractSignedAt: '2026-03-31',
      claimedAt: '2026-04-01',
      months: [
        { month: '2026-02', wageFen: W10875, actualWorkDays: 13 },
        { month: '2026-03', wageFen: W10875, actualWorkDays: 21 },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowFrom).toBe('2026-02-10');
    expect(r.inputs.windowTo).toBe('2026-03-30');
    expect(r.steps.find((s) => s.id === 'month-2026-02')?.valueFen).toBe(650_000);
    expect(r.steps.find((s) => s.id === 'month-2026-03')?.valueFen).toBe(1_050_000);
    expect(r.amountFen).toBe(1_700_000);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiPartialMonth);
  });

  test('例 4（时效按日倒算打到 0）：2024-06-01 入职、2026-08-19 才主张 → 可主张 0，超时效 132,000.00 元', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2024-06-01',
      claimedAt: '2026-08-19',
      months: months('2024-07', 11, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowTo).toBe('2025-05-31');
    expect(r.inputs.shixiaoFrom).toBe('2025-08-19');
    expect(r.amountFen).toBe(0);
    expect(r.claimableFen).toBe(0);
    // 算得出来的 132,000 不静默丢弃——单列出来，用户才看得见拖延的代价。
    expect(r.expiredFen).toBe(13_200_000);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiPartlyExpired);
  });
});

describe('calcDoubleWage：三情形三窗口（第 41 问第 1/3/4 项）', () => {
  test('first-contract：满一个月的次日起算，11 个月上限', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-01-01',
      claimedAt: '2026-02-01',
      months: months('2025-02', 14, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowFrom).toBe('2025-02-01');
    expect(r.inputs.windowTo).toBe('2025-12-31'); // 满一年之日 = 11 个月上限
    expect(r.amountFen).toBe(W12000 * 11);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiWindowCapped);
  });

  test('renewal-lapse：合同期满次日起算（无一个月宽限期），12 个月上限', () => {
    const r = calcDoubleWage({
      scenario: 'renewal-lapse',
      anchorDate: '2025-06-30',
      claimedAt: '2026-08-01',
      months: months('2025-07', 15, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowFrom).toBe('2025-07-01');
    expect(r.inputs.windowTo).toBe('2026-06-30');
    // 窗口 12 个月；主张日 2026-08-01 使最早的 2025-07 掉出时效，故可主张的是 11 个月。
    expect(r.claimableFen + r.expiredFen).toBe(W12000 * 12);
    expect(r.claimableFen).toBe(W12000 * 11);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiWindowCapped);
  });

  test('同一锚点下 renewal-lapse 比 first-contract 早一个月起算、多一个月上限', () => {
    const common = {
      claimedAt: '2027-01-01',
      // 两种情形的起止都落在月中，两端的月份都不满整月，逐月都备上实际工作日
      //（整月的月份用不到这个字段）。
      months: months('2025-07', 18, W12000).map((m) => ({ ...m, actualWorkDays: 20 })),
      minWageFen: MIN_WAGE,
    };
    const first = calcDoubleWage({ ...common, scenario: 'first-contract', anchorDate: '2025-06-30' });
    const renewal = calcDoubleWage({ ...common, scenario: 'renewal-lapse', anchorDate: '2025-06-30' });
    expect(first.inputs.windowFrom).toBe('2025-07-30'); // 满一个月的次日
    expect(renewal.inputs.windowFrom).toBe('2025-07-01'); // 期满次日，无宽限
    expect(renewal.amountFen).toBeGreaterThan(first.amountFen);
  });

  test('openended-refusal：应订之日起算，不受十二个月上限限制', () => {
    const r = calcDoubleWage({
      scenario: 'openended-refusal',
      anchorDate: '2024-01-01',
      claimedAt: '2026-01-01', // 时效放宽到覆盖不到，先看窗口本身
      months: months('2024-01', 18, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowFrom).toBe('2024-01-01');
    expect(r.inputs.windowTo).toBe('2025-06-30'); // 18 个月，没有被截断
    expect(r.flags).toContain(CALC_FLAG.shuangbeiNoTwelveMonthCap);
    expect(r.flags).not.toContain(CALC_FLAG.shuangbeiWindowCapped);
    // 窗口 18 个月，但时效只放进来 2025-01-01 之后的 6 个月。
    expect(r.claimableFen).toBe(W12000 * 6);
    expect(r.expiredFen).toBe(W12000 * 12);
  });

  test('openended-refusal 有实际订立日的，截止到订立前一日', () => {
    const r = calcDoubleWage({
      scenario: 'openended-refusal',
      anchorDate: '2025-01-01',
      contractSignedAt: '2025-04-15',
      claimedAt: '2025-05-01',
      months: [
        ...months('2025-01', 3, W12000),
        { month: '2025-04', wageFen: W12000, actualWorkDays: 10 },
      ],
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.windowTo).toBe('2025-04-14');
    expect(r.amountFen).toBe(W12000 * 3 + Math.round((W12000 / 21.75) * 10));
  });
});

describe('calcDoubleWage：满一年拦截（第 41 问第 2 项）', () => {
  test('只主张满一年之后的期间 → 零额结果 + 拦截说明 step', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2024-01-01',
      claimedAt: '2025-06-01',
      months: months('2025-01', 5, W12000), // 全部晚于满一年之日 2024-12-31
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(0);
    expect(r.expiredFen).toBe(0);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiOneYearBlock);
    const block = r.steps.find((s) => s.id === 'one-year-block');
    expect(block?.valueFen).toBe(0);
    expect(block?.detail).toContain('2024-12-31');
    // 光说「不支持」不够，要给出替代路径。
    expect(block?.detail).toContain('无固定期限劳动合同关系');
  });

  test('满一年拦截只作用于 first-contract：同样的月份走 openended-refusal 照算', () => {
    const r = calcDoubleWage({
      scenario: 'openended-refusal',
      anchorDate: '2025-01-01',
      claimedAt: '2025-06-01',
      months: months('2025-01', 5, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.amountFen).toBe(W12000 * 5);
    expect(r.flags).not.toContain(CALC_FLAG.shuangbeiOneYearBlock);
  });
});

describe('calcDoubleWage：时效按日切分', () => {
  test('时效起点落在月中：31 天的月按 13/31 天切', () => {
    const r = calcDoubleWage({
      scenario: 'openended-refusal',
      anchorDate: '2025-08-01',
      claimedAt: '2026-08-19',
      months: [{ month: '2025-08', wageFen: 3_100_000 }], // 31,000 元 → 每日 1,000 元
      minWageFen: MIN_WAGE,
    });
    expect(r.inputs.shixiaoFrom).toBe('2025-08-19');
    // 08-19 至 08-31 共 13 天在时效内。
    expect(r.claimableFen).toBe(1_300_000);
    expect(r.expiredFen).toBe(1_800_000);
    expect(r.amountFen).toBe(r.claimableFen);
  });

  test('时效抗辩与中断的提示恒随结果给出（公司不提时效不自动适用）', () => {
    const r = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-09-01',
      contractSignedAt: '2026-02-01',
      claimedAt: '2026-02-01',
      months: months('2025-10', 4, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(r.flags).toContain(CALC_FLAG.shuangbeiShixiaoDefense);
    expect(r.flags).toContain(CALC_FLAG.shuangbeiShixiaoInterrupt);
    expect(r.steps.find((s) => s.id === 'shixiao')?.detail).toContain('须由用人单位提出');
  });

  test('主张日每往后拖一个月，最早的一个月就掉出时效', () => {
    const build = (claimedAt: string) =>
      calcDoubleWage({
        scenario: 'first-contract',
        anchorDate: '2025-03-01',
        claimedAt,
        months: months('2025-04', 11, W12000),
        minWageFen: MIN_WAGE,
      });
    const early = build('2026-04-01');
    const late = build('2026-05-01');
    expect(early.claimableFen).toBeGreaterThan(late.claimableFen);
    expect(early.claimableFen + early.expiredFen).toBe(late.claimableFen + late.expiredFen);
  });
});

describe('calcDoubleWage：入参与契约', () => {
  const base = {
    scenario: 'first-contract' as const,
    anchorDate: '2025-09-01',
    contractSignedAt: '2026-02-01',
    claimedAt: '2026-02-01',
    months: months('2025-10', 4, W12000),
    minWageFen: MIN_WAGE,
  };

  test('月工资低于最低工资 → 按最低工资兜底', () => {
    const r = calcDoubleWage({ ...base, months: months('2025-10', 4, 200_000) });
    expect(r.amountFen).toBe(MIN_WAGE * 4);
    expect(r.flags).toContain(CALC_FLAG.minWageFloor);
    // 逐月循环里 push 了 4 次，交出去必须是去重后的。
    expect(r.flags.filter((f) => f === CALC_FLAG.minWageFloor)).toHaveLength(1);
  });

  test('未传最低工资 → 用缺省并打待核实 flag', () => {
    const r = calcDoubleWage({ ...base, minWageFen: undefined });
    expect(r.inputs.minWageFen).toBe(MIN_WAGE_FEN_DEFAULT);
    expect(r.flags).toContain(CALC_FLAG.minWageUnverified);
  });

  test('不满整月却没给 actualWorkDays → 抛错，不静默按整月算', () => {
    expect(() =>
      calcDoubleWage({
        ...base,
        contractSignedAt: '2026-01-15',
        months: months('2025-10', 4, W12000),
      }),
    ).toThrow(/actualWorkDays/);
  });

  test('折算分母缺省 21.75，可覆盖', () => {
    expect(SHUANGBEI_MONTHLY_PAY_DAYS_DEFAULT).toBe(21.75);
    const r = calcDoubleWage({
      ...base,
      contractSignedAt: undefined,
      monthlyPayDays: 20.92,
      // 起算点 2025-10-05 落在月中 → 该月不满整月，走折算分支。
      anchorDate: '2025-09-05',
      months: [{ month: '2025-10', wageFen: W10875, actualWorkDays: 10 }],
      claimedAt: '2025-11-01',
    });
    expect(r.inputs.monthlyPayDays).toBe(20.92);
    expect(r.amountFen).toBe(Math.round((W10875 / 20.92) * 10));
  });

  test('months 必须升序不重复', () => {
    expect(() =>
      calcDoubleWage({ ...base, months: [...months('2025-10', 2, W12000)].reverse() }),
    ).toThrow(/升序/);
    expect(() =>
      calcDoubleWage({
        ...base,
        months: [
          { month: '2025-10', wageFen: W12000 },
          { month: '2025-10', wageFen: W12000 },
        ],
      }),
    ).toThrow(/升序/);
    expect(() => calcDoubleWage({ ...base, months: [] })).toThrow(/不能为空/);
  });

  test('非法日期串抛错', () => {
    expect(() => calcDoubleWage({ ...base, anchorDate: '2025/09/01' })).toThrow(/不是合法日期串/);
    expect(() => calcDoubleWage({ ...base, claimedAt: '2026-02-30' })).toThrow(/不是真实存在的日期/);
    expect(() => calcDoubleWage({ ...base, months: [{ month: '2025-13', wageFen: 1 }] })).toThrow(
      /不是真实存在的月份/,
    );
  });

  test('契约通用项：inputs 冻结、整数分、basis 挂法条、同输入同输出', () => {
    const r = calcDoubleWage(base);
    expect(Object.isFrozen(r.inputs)).toBe(true);
    expect(Number.isInteger(r.amountFen)).toBe(true);
    for (const s of r.steps) {
      if (s.valueFen !== undefined) expect(Number.isInteger(s.valueFen)).toBe(true);
    }
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第八十二条', packId: 'calc-weiqian-hetong-shuangbei' }),
    );
    expect(r.basis).toContainEqual(
      expect.objectContaining({ article: '第41问', packId: 'statute-jgf-2024-534-jieda-1' }),
    );
    expect(calcDoubleWage(base)).toEqual(calcDoubleWage(base));
  });

  test('claimableFen + expiredFen 恒等于窗口内算出的总额', () => {
    const r = calcDoubleWage({ ...base, claimedAt: '2026-06-15' });
    const monthSum = r.steps
      .filter((s) => s.id.startsWith('month-'))
      .reduce((sum, s) => sum + (s.valueFen ?? 0), 0);
    expect(monthSum).toBe(r.claimableFen);
    expect(r.claimableFen + r.expiredFen).toBe(W12000 * 4);
  });
});

describe('双倍工资：窗口边界不随本机时区漂移', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const TZS = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  // 用带时间的 canonical / ISO 串喂日期：裸 new Date 在 UTC+8 下会把 00:00:00 退到前一天，
  // 起算点一退就整整多算一个月，终点一退就少算一个月。
  test.each(TZS)('TZ=%s：起止、时效起点与金额均一致', (tz) => {
    process.env.TZ = tz;
    const canonical = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-03-01 00:00:00',
      claimedAt: '2026-03-01 16:00:00',
      months: months('2025-04', 11, W12000),
      minWageFen: MIN_WAGE,
    });
    const iso = calcDoubleWage({
      scenario: 'first-contract',
      anchorDate: '2025-03-01T00:00:00Z',
      claimedAt: '2026-03-01T16:00:00Z',
      months: months('2025-04', 11, W12000),
      minWageFen: MIN_WAGE,
    });
    expect(canonical.inputs.windowFrom).toBe('2025-04-01');
    expect(canonical.inputs.windowTo).toBe('2026-02-28');
    expect(canonical.inputs.shixiaoFrom).toBe('2025-03-01');
    expect(canonical.amountFen).toBe(13_200_000);
    expect(iso.amountFen).toBe(canonical.amountFen);
    expect(iso.inputs.windowTo).toBe(canonical.inputs.windowTo);
  });

  test('显式数字时区偏移不收（归一按 UTC 会静默差一天）', () => {
    expect(() =>
      calcDoubleWage({
        scenario: 'first-contract',
        anchorDate: '2025-03-01T00:00:00+08:00',
        claimedAt: '2026-03-01',
        months: months('2025-04', 11, W12000),
      }),
    ).toThrow(/不是合法日期串/);
  });
});
