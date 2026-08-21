// app/src/lib/agent/calc/nianjia.ts
// 未休年休假工资报酬（北京口径）。口径唯一来源：knowledge/packs/calc/nianjia-300.md，
// 北京侧印证见 knowledge/packs/statutes/jgf-2024-534-jieda-1.md 第 62 问。改数字前先改卡片。
//
// 三个最容易算错、且都直接影响金额的点：
//   ① 天数按**累计工作时间**（含跨单位、视同工作期间，实施办法第四条）定 5/10/15，
//      不是本单位司龄——公司只按司龄给 5 天是最常见的少算。
//   ② 日工资分母是 **21.75**（实施办法第十一条写死），且月平均工资须**剔除加班费**。
//      别和加班费的 20.92 之争混（那是另一套，见 jiabanfei.ts）。
//   ③ 实际能主张的是 **200%** 不是 300%——300% 里含随当月工资已经发过的那 100%
//      （实施办法第十条：「其中包含用人单位支付职工正常工作期间的工资收入」）。
//      按 300% 写请求会被扣掉已发部分，等于自己把请求写虚。
//
// 不做的事：条例第四条五种「不享受当年年休假」的情形（长病假、20 天以上带薪事假、寒暑假）
// 依赖事实认定，本文件不判——由 agent 层问诊确认后再决定是否调用，入参默认「资格已确认」。

import { asOrdinal, daysBetweenInclusive, parseDate, ymdText, type Ymd } from './date';
import { days as daysText, yuan } from './format';
import { MIN_WAGE_FEN_DEFAULT } from './jingji-buchang';
import {
  CALC_FLAG,
  CALC_VERSION,
  type CalcBasis,
  type CalcFlag,
  type CalcResult,
  type CalcStep,
  type InputSource,
} from './types';

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * 年假日工资的折算分母：**21.75** 天/月（《企业职工带薪年休假实施办法》第十一条）。
 * 法条写死，不受加班费那边 21.75 与 20.92 之争的影响，故本常量不开放入参覆盖。
 * 与 jiabanfei.ts 的 JIABAN_MONTHLY_WORK_DAYS_LEGACY(20.92) 是两个不同法源的数，别互换。
 */
export const NIANJIA_MONTHLY_PAY_DAYS = 21.75;

/** 折算分母 365 天（实施办法第五条、第十二条均写「÷ 365 天」，闰年也是 365）。 */
const PRORATE_DENOMINATOR = 365;

/** 可主张的倍数：300% − 已随工资发过的 100% = **200%** 差额。 */
const CLAIMABLE_MULTIPLIER = 2;

// ───────────────────────────── 入参与快照 ─────────────────────────────

/** 往年（结算年度之前）某一年度的未休天数。 */
export interface PriorYearUnused {
  year: number;
  unusedDays: number;
}

export interface AnnualLeaveInput {
  /**
   * **累计**工作年限（年，含跨单位与视同工作期间）。用于定 5/10/15 天档。
   * 不满 1 年的给 0.x，落「不享受」档。
   */
  cumulativeWorkYears: number;
  /** 前 12 个月**剔除加班工资后**的月平均工资（分）。不满 12 个月按实际月份平均。 */
  avgMonthlyWageExOvertimeFen: number;
  /** 结算截止日：离职结算给离职日；在职按年度结算给该年 12-31。'YYYY-MM-DD' 或时间串。 */
  throughDate: string;
  /** 本单位入职日。落在结算年度内时按实施办法第五条只算入职之后的日历天。 */
  employedFrom?: string;
  /** 结算年度内公司已安排（已休）的年假天数。 */
  arrangedDaysThisYear: number;
  /** 往年未休明细，逐年给。年份须早于结算年度。 */
  priorYears?: PriorYearUnused[];
  /** 覆盖全年应休天数：合同/制度约定高于法定的从其约定（实施办法第十三条）。 */
  fullYearDaysOverride?: number;
  /** 覆盖最低工资（分）。不给则用 MIN_WAGE_FEN_DEFAULT。 */
  minWageFen?: number;
  inputSources?: Record<string, InputSource>;
}

export interface AnnualLeaveInputs {
  cumulativeWorkYears: number;
  avgMonthlyWageExOvertimeFen: number;
  throughDate: string;
  employedFrom?: string;
  arrangedDaysThisYear: number;
  priorYears: PriorYearUnused[];
  fullYearDays: number;
  minWageFen: number;
  monthlyPayDays: number;
}

// ───────────────────────────── 天数 ─────────────────────────────

/**
 * 全年应休天数（条例第三条，按累计工作时间）：
 * 满 1 年不满 10 年 → 5；满 10 年不满 20 年 → 10；满 20 年以上 → 15；不满 1 年 → 0。
 */
export function annualLeaveDaysFor(cumulativeWorkYears: number): number {
  if (cumulativeWorkYears < 1) return 0;
  if (cumulativeWorkYears < 10) return 5;
  if (cumulativeWorkYears < 20) return 10;
  return 15;
}

/** 折算明细，供 step 展示与测试锚点。 */
export interface ProratedLeave {
  /** 结算年度内在本单位的日历天数（闭区间计数）。 */
  calendarDays: number;
  /** 折算原值（未取整），如 181 ÷ 365 × 5 = 2.4795。 */
  raw: number;
  /** 向下取整后的应休天数——不足 1 整天的部分不支付/不享受。 */
  days: number;
  /** 折算区间起点（入职日与年初孰晚）。 */
  from: string;
  /** 折算区间终点（结算截止日）。 */
  to: string;
}

/**
 * 当年度应休天数折算（实施办法第五条新入职 / 第十二条离职，公式同形）：
 *   （当年度在本单位日历天数 ÷ 365）× 全年应休天数，**向下取整**。
 * 入职日晚于年初的按入职日起算，否则按 1 月 1 日起算。
 */
export function proratedAnnualLeaveDays(
  fullYearDays: number,
  throughDate: string,
  employedFrom?: string,
): ProratedLeave {
  const to = parseDate(throughDate, 'throughDate');
  const yearStart: Ymd = { y: to.y, m: 1, d: 1 };
  let from = yearStart;
  if (employedFrom !== undefined) {
    const hired = parseDate(employedFrom, 'employedFrom');
    if (asOrdinal(hired) > asOrdinal(to)) {
      throw new Error(`employedFrom(${employedFrom}) 晚于 throughDate(${throughDate})`);
    }
    if (asOrdinal(hired) > asOrdinal(yearStart)) from = hired;
  }
  const calendarDays = daysBetweenInclusive(from, to);
  // 先乘后除，两个整数相乘再除 365——整除得到的商是精确值，不会出现 4.999… 被砍成 4。
  const raw = (calendarDays * fullYearDays) / PRORATE_DENOMINATOR;
  return {
    calendarDays,
    raw,
    days: Math.floor(raw),
    from: ymdText(from),
    to: ymdText(to),
  };
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const NIANJIA_PACK = 'calc-nianjia-300';
const TIAOLI = '《职工带薪年休假条例》';
const BANFA = '《企业职工带薪年休假实施办法》';

const NIANJIA_BASIS: CalcBasis[] = [
  { law: TIAOLI, article: '第三条', packId: NIANJIA_PACK },
  { law: TIAOLI, article: '第五条第三款', packId: NIANJIA_PACK },
  { law: BANFA, article: '第四条', packId: NIANJIA_PACK },
  { law: BANFA, article: '第十条', packId: NIANJIA_PACK },
  { law: BANFA, article: '第十一条', packId: NIANJIA_PACK },
  { law: BANFA, article: '第十二条', packId: NIANJIA_PACK },
  {
    law: '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》',
    article: '第62问',
    packId: 'statute-jgf-2024-534-jieda-1',
  },
];

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 未休年休假工资报酬**差额**（可主张的 200% 部分）。
 *
 * kind 用 '年假'，与 claims.kind 枚举一致。
 */
export function calcAnnualLeavePay(input: AnnualLeaveInput): CalcResult<AnnualLeaveInputs> {
  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const flags: CalcFlag[] = [];
  const steps: CalcStep[] = [];

  // ── 全年应休天数 ──
  const legalDays = annualLeaveDaysFor(input.cumulativeWorkYears);
  const fullYearDays = input.fullYearDaysOverride ?? legalDays;
  flags.push(CALC_FLAG.nianjiaCumulativeTenure);
  if (legalDays === 0) flags.push(CALC_FLAG.nianjiaNoEntitlement);

  steps.push({
    id: 'entitlement',
    title: '按累计工作时间确定全年应休天数',
    detail:
      `累计工作 ${daysText(input.cumulativeWorkYears)} 年 → 法定全年应休 ${legalDays} 天` +
      `（满1年不满10年5天／满10年不满20年10天／满20年以上15天）。` +
      (input.fullYearDaysOverride !== undefined
        ? `合同或规章制度约定 ${input.fullYearDaysOverride} 天，高于法定的从其约定（实施办法第十三条）→ 按 ${fullYearDays} 天。`
        : '') +
      `累计工作时间含在**不同用人单位**工作的期间，不是本单位司龄——公司只按司龄定档的要用社保记录、` +
      `离职证明反驳。`,
  });

  // ── 当年度折算 ──
  const prorated = proratedAnnualLeaveDays(fullYearDays, input.throughDate, input.employedFrom);
  const unusedThisYear = Math.max(0, prorated.days - input.arrangedDaysThisYear);
  if (prorated.raw > prorated.days) flags.push(CALC_FLAG.nianjiaSubDayDropped);
  if (input.arrangedDaysThisYear > prorated.days) flags.push(CALC_FLAG.nianjiaOverArranged);

  steps.push({
    id: 'prorate',
    title: '当年度应休天数折算',
    detail:
      `${prorated.from} 至 ${prorated.to} 共 ${prorated.calendarDays} 个日历天；` +
      `${prorated.calendarDays} ÷ 365 × ${fullYearDays} = ${daysText(prorated.raw)} → ` +
      `不足 1 整天的部分不支付，折算应休 ${prorated.days} 天；` +
      `已安排 ${input.arrangedDaysThisYear} 天 → 应休未休 ${unusedThisYear} 天。` +
      (input.arrangedDaysThisYear > prorated.days
        ? `已休多于折算 ${input.arrangedDaysThisYear - prorated.days} 天，本项为 0，` +
          `且依实施办法第十二条第三款**多休不再扣回**，公司不得从工资或补偿金中倒扣。`
        : ''),
  });

  // ── 日工资 ──
  const wageFen = Math.max(input.avgMonthlyWageExOvertimeFen, minWageFen);
  if (input.avgMonthlyWageExOvertimeFen < minWageFen) flags.push(CALC_FLAG.minWageFloor);
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);
  const dailyWageFen = wageFen / NIANJIA_MONTHLY_PAY_DAYS;

  steps.push({
    id: 'daily-wage',
    title: '日工资收入（月平均工资 ÷ 21.75）',
    detail:
      `前 12 个月**剔除加班费后**的月平均工资 ${yuan(input.avgMonthlyWageExOvertimeFen)} 元` +
      (input.avgMonthlyWageExOvertimeFen < minWageFen
        ? ` < 北京市最低工资 ${yuan(minWageFen)} 元 → 按最低工资 ${yuan(minWageFen)} 元计`
        : '') +
      `；${yuan(wageFen)} ÷ 21.75 = ${yuan(dailyWageFen)} 元/日。` +
      `分母 21.75 由实施办法第十一条写死，与加班费的 20.92 之争无关。`,
    valueFen: Math.round(dailyWageFen),
  });

  // ── 逐年度金额 ──
  const settlementYear = parseDate(input.throughDate, 'throughDate').y;
  const priorYears = (input.priorYears ?? []).map((y) => {
    if (y.year >= settlementYear) {
      throw new Error(
        `priorYears 的年度(${y.year}) 须早于结算年度(${settlementYear})，当年度已由折算算过`,
      );
    }
    if (y.unusedDays < 0) throw new Error(`priorYears[${y.year}].unusedDays 不能为负`);
    return { year: y.year, unusedDays: y.unusedDays };
  });
  priorYears.sort((a, b) => a.year - b.year);
  if (priorYears.some((y) => y.year < settlementYear - 1)) {
    flags.push(CALC_FLAG.nianjiaShixiaoConservative);
  }

  // 每个年度是一条可独立列进请求事项的账，各自取整后相加——这样 steps 逐条加得起来，
  // 当庭被逐年质疑时不会出现「分项之和不等于总额」的尴尬。
  const lineOf = (unusedDays: number) =>
    Math.round(dailyWageFen * unusedDays * CLAIMABLE_MULTIPLIER);

  let amountFen = 0;
  for (const y of priorYears) {
    const lineFen = lineOf(y.unusedDays);
    amountFen += lineFen;
    steps.push({
      id: `year-${y.year}`,
      title: `${y.year} 年度未休 ${y.unusedDays} 天`,
      detail:
        `${yuan(dailyWageFen)} × ${y.unusedDays} 天 × 200% = ${yuan(lineFen)} 元。` +
        (y.year < settlementYear - 1
          ? `该年度早于「离职当年 + 上一年度」，按保守口径时效风险高，可主张但预期要低。`
          : ''),
      valueFen: lineFen,
    });
  }

  const thisYearFen = lineOf(unusedThisYear);
  amountFen += thisYearFen;
  steps.push({
    id: `year-${settlementYear}`,
    title: `${settlementYear} 年度（结算年度）未休 ${unusedThisYear} 天`,
    detail: `${yuan(dailyWageFen)} × ${unusedThisYear} 天 × 200% = ${yuan(thisYearFen)} 元。`,
    valueFen: thisYearFen,
  });

  const totalUnusedDays =
    unusedThisYear + priorYears.reduce((sum, y) => sum + y.unusedDays, 0);

  steps.push({
    id: 'amount',
    title: '合计可主张差额（200%，不是 300%）',
    detail:
      `未休合计 ${totalUnusedDays} 天，差额 ${yuan(amountFen)} 元。` +
      `法定标准是日工资的 **300%**，其中 100% 已随当月工资发过（实施办法第十条），` +
      `仲裁请求应写「支付应休未休年休假工资报酬差额」并按 **200%** 计；` +
      `按 300% 写会被扣掉已发部分。`,
    valueFen: amountFen,
  });

  const inputs: AnnualLeaveInputs = Object.freeze({
    cumulativeWorkYears: input.cumulativeWorkYears,
    avgMonthlyWageExOvertimeFen: input.avgMonthlyWageExOvertimeFen,
    throughDate: input.throughDate.slice(0, 10),
    employedFrom: input.employedFrom?.slice(0, 10),
    arrangedDaysThisYear: input.arrangedDaysThisYear,
    priorYears,
    fullYearDays,
    minWageFen,
    monthlyPayDays: NIANJIA_MONTHLY_PAY_DAYS,
  });

  return {
    kind: '年假',
    amountFen,
    formula:
      `${yuan(dailyWageFen)}（日工资 = ${yuan(wageFen)} ÷ 21.75） × ${totalUnusedDays} 天 × 200%` +
      ` = ${yuan(amountFen)} 元`,
    inputs,
    steps,
    flags,
    basis: NIANJIA_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
