// app/src/lib/agent/calc/shuangbei.ts
// 未签书面劳动合同二倍工资**差额**（北京口径）。
// 口径唯一来源：knowledge/packs/calc/weiqian-hetong-shuangbei.md；
// 三种情形的起止与上限以 knowledge/packs/statutes/jgf-2024-534-jieda-1.md 第 41 问逐字原文为准。
//
// 主张的是「差额」——惩罚性的那 1 倍。正常那 1 倍已随月工资发过，仲裁请求写
// 「支付未订立书面劳动合同二倍工资差额 X 元」；写成「二倍工资 X 元」会被按已发部分抵扣。
//
// 三种情形三条窗口（第 41 问第 1、3、4 项，别互相套用）：
//   · first-contract    首份合同未签：用工之日满一个月的**次日**起 → 订立书面合同前一日止，
//                       最长 **11 个月**；且用工满一年后不再支持（第 2 项，见下）。
//   · renewal-lapse     合同期满未续签：合同期满的**次日**起（**无一个月宽限期**——这是与
//                       first-contract 最容易混、也最影响金额的一处差别）→ 补订前一日止，
//                       最长 **12 个月**。
//   · openended-refusal 应订无固定期限而不订：自应当订立之日起 → 实际订立前一日止，
//                       **不受十二个月上限限制**。
//
// 满一年拦截（第 41 问第 2 项，仅 first-contract）：用工满一年即视为已订立无固定期限合同，
// 「只主张满一年后的二倍工资」的，增加一倍部分不予支持——这类诉求直接返回零额并给出解释，
// 不能让用户带着一个必然被驳的请求去开庭。
//
// 时效（第 41 问第 5 项）：增加一倍的部分是惩罚性赔偿、不是劳动报酬，适用一年普通时效，
// **自主张权利之日起向前一年按日计算**。所以越拖能拿的越少——超时效的部分单列 expiredFen，
// 不静默丢弃：时效抗辩须用人单位提出，且有证据证明中断/中止的除外。

import {
  addDays,
  addMonths,
  asOrdinal,
  daysBetweenInclusive,
  monthEnd,
  monthStart,
  parseDate,
  parseMonth,
  ymdText,
  type Ymd,
} from './date';
import { yuan } from './format';
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
 * 不满一月折算的分母：21.75 天/月，依 534 号第 57 问第 5 项的日工资折算规则。
 * 法释〔2025〕12 号第六条只写「按该月实际工作日计算」未定分母，北京采哪种**待核实**
 * （另一种实操算法是按当月计薪天数），故本常量开放入参覆盖。
 */
export const SHUANGBEI_MONTHLY_PAY_DAYS_DEFAULT = 21.75;

const CAP_MONTHS: Record<DoubleWageScenario, number | null> = {
  'first-contract': 11,
  'renewal-lapse': 12,
  // 第 41 问第 4 项：不受支付十二个月二倍工资上限限制。
  'openended-refusal': null,
};

// ───────────────────────────── 入参与快照 ─────────────────────────────

export type DoubleWageScenario = 'first-contract' | 'renewal-lapse' | 'openended-refusal';

export interface DoubleWageMonth {
  /** 'YYYY-MM'。 */
  month: string;
  /** 该月**应当正常支付**的工资（分，第 41 问第 5 项）。基数口径见第 55 问第 3 项。 */
  wageFen: number;
  /** 该月实际工作日数。仅窗口两端不满整月的月份需要，整月不用给。 */
  actualWorkDays?: number;
}

export interface DoubleWageInput {
  scenario: DoubleWageScenario;
  /**
   * 起算锚点，按情形取不同事实：
   *   first-contract    → 用工之日；
   *   renewal-lapse     → 原劳动合同期满之日；
   *   openended-refusal → 应当订立无固定期限劳动合同之日。
   */
  anchorDate: string;
  /**
   * 订立（补订）书面合同之日 / 实际订立无固定期限合同之日。窗口终点取其前一日。
   * 始终未订立的不给，窗口终点则取 months 最后一个月的月末（再受上限与满一年规则截断）。
   */
  contractSignedAt?: string;
  /** 主张权利之日。时效自该日向前一年按日倒算，是本公式最敏感的一个入参。 */
  claimedAt: string;
  /** 逐月工资明细。只算落在窗口内的月份，窗口外的月份原样列入 steps 说明为什么不算。 */
  months: DoubleWageMonth[];
  /** 覆盖最低工资（分）。月工资低于此数的按此数计。 */
  minWageFen?: number;
  /** 覆盖不满一月的折算分母（缺省 21.75）。 */
  monthlyPayDays?: number;
  inputSources?: Record<string, InputSource>;
}

export interface DoubleWageInputs {
  scenario: DoubleWageScenario;
  anchorDate: string;
  contractSignedAt?: string;
  claimedAt: string;
  months: DoubleWageMonth[];
  windowFrom: string;
  windowTo: string;
  shixiaoFrom: string;
  minWageFen: number;
  monthlyPayDays: number;
}

/**
 * 二倍工资的结果比别的公式多两格：amountFen（= claimableFen）只是**时效内**能拿的，
 * expiredFen 是算得出来但已过时效的部分。两个数都要交给用户——超时效不等于必然拿不到
 * （公司不提时效抗辩就不适用，有证据证明中断/中止的也除外），但更重要的是让用户看见
 * 「再拖下去还要掉多少」。
 */
export interface DoubleWageResult extends CalcResult<DoubleWageInputs> {
  /** 时效内可主张金额（= amountFen）。 */
  claimableFen: number;
  /** 落在时效之外的金额。 */
  expiredFen: number;
}

// ───────────────────────────── 窗口 ─────────────────────────────

interface Window {
  from: Ymd;
  /** 终点。start 晚于 end 表示窗口为空（例如只主张满一年之后的期间）。 */
  to: Ymd;
  /** 满一年之日（仅 first-contract 有），窗口终点不得越过它。 */
  oneYearDay?: Ymd;
  /** 上限截断确实生效了。 */
  capped: boolean;
  fromReason: string;
  toReason: string;
}

function resolveWindow(input: DoubleWageInput): Window {
  const anchor = parseDate(input.anchorDate, 'anchorDate');
  const signed =
    input.contractSignedAt === undefined
      ? undefined
      : parseDate(input.contractSignedAt, 'contractSignedAt');

  let from: Ymd;
  let fromReason: string;
  let oneYearDay: Ymd | undefined;
  switch (input.scenario) {
    case 'first-contract':
      // 「自用工之日满一个月的次日起」：用工日 03-01 → 满一个月之日 03-31 → 次日 04-01。
      from = addMonths(anchor, 1);
      fromReason = `用工之日 ${ymdText(anchor)} 起满一个月的次日`;
      // 「满一年之日」：用工日 03-01 → 次年 02-28/29。
      oneYearDay = addDays(addMonths(anchor, 12), -1);
      break;
    case 'renewal-lapse':
      // 第 41 问第 3 项：起算点为合同期满的**次日**，没有「满一个月」的宽限。
      from = addDays(anchor, 1);
      fromReason = `原劳动合同期满之日 ${ymdText(anchor)} 的次日（无一个月宽限期）`;
      break;
    case 'openended-refusal':
      from = anchor;
      fromReason = `应当订立无固定期限劳动合同之日 ${ymdText(anchor)}`;
      break;
  }

  // 事件终点：订立书面合同的前一日；未订立的按明细最后一个月的月末。
  const lastMonth = input.months.at(-1);
  if (lastMonth === undefined) throw new Error('months 不能为空');
  let to: Ymd;
  let toReason: string;
  if (signed !== undefined) {
    to = addDays(signed, -1);
    toReason = `订立书面合同之日 ${ymdText(signed)} 的前一日`;
  } else {
    to = monthEnd(parseMonth(lastMonth.month, 'months[].month'));
    toReason = `未订立书面合同，按明细最后一个月 ${lastMonth.month} 的月末`;
  }

  let capped = false;
  const capMonths = CAP_MONTHS[input.scenario];
  if (capMonths !== null) {
    const capEnd = addDays(addMonths(from, capMonths), -1);
    if (asOrdinal(capEnd) < asOrdinal(to)) {
      to = capEnd;
      toReason = `${capMonths} 个月上限截断至 ${ymdText(capEnd)}`;
      capped = true;
    }
  }
  if (oneYearDay !== undefined && asOrdinal(oneYearDay) < asOrdinal(to)) {
    to = oneYearDay;
    toReason = `用工满一年之日 ${ymdText(oneYearDay)}（满一年后不再支持）`;
    capped = true;
  }

  return { from, to, oneYearDay, capped, fromReason, toReason };
}

// ───────────────────────────── 逐月拆账 ─────────────────────────────

interface MonthLine {
  month: string;
  /** 该月落在窗口内的天数，0 表示整月在窗口外。 */
  windowDays: number;
  /** 整月都在窗口内。 */
  full: boolean;
  totalFen: number;
  claimableFen: number;
  expiredFen: number;
  detail: string;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const SHUANGBEI_PACK = 'calc-weiqian-hetong-shuangbei';
const JGF534 =
  '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》';
const JGF534_PACK = 'statute-jgf-2024-534-jieda-1';
const JIESHI2 = '《最高人民法院关于审理劳动争议案件适用法律问题的解释（二）》（法释〔2025〕12号）';

const SHUANGBEI_BASIS: CalcBasis[] = [
  { law: '《中华人民共和国劳动合同法》', article: '第八十二条', packId: SHUANGBEI_PACK },
  { law: '《中华人民共和国劳动合同法》', article: '第十条', packId: SHUANGBEI_PACK },
  { law: '《中华人民共和国劳动合同法》', article: '第十四条第三款', packId: SHUANGBEI_PACK },
  { law: JIESHI2, article: '第六条', packId: 'statute-fashi-2025-12-jieshi-2' },
  { law: JIESHI2, article: '第九条', packId: 'statute-fashi-2025-12-jieshi-2' },
  { law: '《中华人民共和国劳动争议调解仲裁法》', article: '第二十七条', packId: SHUANGBEI_PACK },
  { law: JGF534, article: '第41问', packId: JGF534_PACK },
  { law: JGF534, article: '第55问第3项', packId: JGF534_PACK },
];

const SCENARIO_TEXT: Record<DoubleWageScenario, string> = {
  'first-contract': '首份书面合同未订立（第41问第1项，最长11个月）',
  'renewal-lapse': '合同期满未补订（第41问第3项，最长12个月）',
  'openended-refusal': '应订无固定期限而不订（第41问第4项，无月数上限）',
};

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 未签书面劳动合同二倍工资差额。kind 用 '双倍工资'，与 claims.kind 枚举一致。
 */
export function calcDoubleWage(input: DoubleWageInput): DoubleWageResult {
  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const monthlyPayDays = input.monthlyPayDays ?? SHUANGBEI_MONTHLY_PAY_DAYS_DEFAULT;
  const flags: CalcFlag[] = [];

  const claimedAt = parseDate(input.claimedAt, 'claimedAt');
  // 「自劳动者主张权利之日起向前一年按日计算」：主张日往回数满一年的那一天起算，
  // 落在这一天之前的天数已过时效。往后拖一天，最早的一天就掉出去。
  const shixiaoFrom = addMonths(claimedAt, -12);

  const months = input.months.map((m) => {
    const at = parseMonth(m.month, 'months[].month');
    return { ...m, at };
  });
  for (let i = 1; i < months.length; i += 1) {
    if (asOrdinal(months[i].at) <= asOrdinal(months[i - 1].at)) {
      throw new Error(`months 必须按月份升序且不重复：${months[i - 1].month} → ${months[i].month}`);
    }
  }

  const window = resolveWindow(input);
  const windowEmpty = asOrdinal(window.from) > asOrdinal(window.to);
  if (window.capped) flags.push(CALC_FLAG.shuangbeiWindowCapped);
  if (input.scenario === 'openended-refusal') flags.push(CALC_FLAG.shuangbeiNoTwelveMonthCap);
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);

  const steps: CalcStep[] = [
    {
      id: 'scenario',
      title: '认定情形与计算窗口',
      detail:
        `情形：${SCENARIO_TEXT[input.scenario]}。` +
        `起算：${window.fromReason} → ${ymdText(window.from)}；` +
        `终止：${window.toReason} → ${ymdText(window.to)}。` +
        (windowEmpty ? '起算点晚于终止点，窗口为空。' : ''),
    },
  ];

  const lines: MonthLine[] = [];
  const excluded: string[] = [];
  /** 因落在「用工满一年之后」而被排除的月份（第 41 问第 2 项），单独留痕。 */
  const blockedMonths: string[] = [];
  let hasPartial = false;

  for (const m of months) {
    const mStart = monthStart(m.at);
    const mEnd = monthEnd(m.at);
    const from = asOrdinal(mStart) > asOrdinal(window.from) ? mStart : window.from;
    const to = asOrdinal(mEnd) < asOrdinal(window.to) ? mEnd : window.to;

    if (windowEmpty || asOrdinal(from) > asOrdinal(to)) {
      const afterEnd = asOrdinal(mStart) > asOrdinal(window.to);
      if (
        afterEnd &&
        window.oneYearDay !== undefined &&
        asOrdinal(mStart) > asOrdinal(window.oneYearDay)
      ) {
        blockedMonths.push(m.month);
      }
      excluded.push(`${m.month}（${afterEnd ? '晚于窗口终止点' : '早于起算点'}）`);
      continue;
    }

    const wageFen = Math.max(m.wageFen, minWageFen);
    if (m.wageFen < minWageFen) flags.push(CALC_FLAG.minWageFloor);

    const windowDays = daysBetweenInclusive(from, to);
    const full = asOrdinal(from) === asOrdinal(mStart) && asOrdinal(to) === asOrdinal(mEnd);
    let totalFen: number;
    let detail: string;
    if (full) {
      totalFen = wageFen;
      detail = `整月在窗口内：${yuan(wageFen)} × 1 = ${yuan(totalFen)} 元`;
    } else {
      hasPartial = true;
      if (m.actualWorkDays === undefined) {
        throw new Error(
          `${m.month} 只有 ${ymdText(from)} 至 ${ymdText(to)} 落在窗口内，不满整月，` +
            `须给 actualWorkDays（该期间实际工作日数）`,
        );
      }
      const dailyFen = wageFen / monthlyPayDays;
      totalFen = Math.round(dailyFen * m.actualWorkDays);
      detail =
        `${ymdText(from)} 至 ${ymdText(to)} 不满整月，按实际工作日折算（法释〔2025〕12号第六条）：` +
        `${yuan(wageFen)} ÷ ${monthlyPayDays} × ${m.actualWorkDays} 个工作日 = ${yuan(totalFen)} 元`;
    }

    // 时效按日切：该月落在窗口内的天数中，主张日往前一年之内的那部分按比例可主张。
    // 分母取「窗口内该月天数」而非该月日历天数——整月时两者相等（即第 41 问的按日口径），
    // 不满整月时才有区别，用窗口内天数才不会把同一个月既按工作日折一次、又按日历日再折一次。
    const claimableDays =
      asOrdinal(to) < asOrdinal(shixiaoFrom)
        ? 0
        : daysBetweenInclusive(
            asOrdinal(from) > asOrdinal(shixiaoFrom) ? from : shixiaoFrom,
            to,
          );
    let claimableFen: number;
    if (claimableDays >= windowDays) {
      claimableFen = totalFen;
    } else if (claimableDays <= 0) {
      claimableFen = 0;
      detail += `；全部早于时效起点 ${ymdText(shixiaoFrom)}，已过时效`;
    } else {
      claimableFen = Math.round((totalFen * claimableDays) / windowDays);
      detail +=
        `；时效起点 ${ymdText(shixiaoFrom)} 落在本月内，按日切分 ${claimableDays}/${windowDays} 天` +
        ` → 时效内 ${yuan(claimableFen)} 元`;
    }

    lines.push({
      month: m.month,
      windowDays,
      full,
      totalFen,
      claimableFen,
      expiredFen: totalFen - claimableFen,
      detail,
    });
  }

  if (hasPartial) flags.push(CALC_FLAG.shuangbeiPartialMonth);

  const totalFen = lines.reduce((sum, l) => sum + l.totalFen, 0);
  const claimableFen = lines.reduce((sum, l) => sum + l.claimableFen, 0);
  const expiredFen = totalFen - claimableFen;

  // 满一年拦截：first-contract 情形下主张的期间整体落在满一年之后的，直接给零额和解释。
  // 「只主张满一年后的二倍工资」在北京是明确不予支持的（第 41 问第 2 项），
  // 让用户揣着这个请求去开庭，比告诉他拿不到更坏。
  if (blockedMonths.length > 0 && window.oneYearDay !== undefined) {
    flags.push(CALC_FLAG.shuangbeiOneYearBlock);
    steps.push({
      id: 'one-year-block',
      title: '满一年后的期间不支持二倍工资（第41问第2项）',
      detail:
        `用工之日满一年之日为 ${ymdText(window.oneYearDay)}，此后视为双方已订立无固定期限劳动合同。` +
        `依 534 号第 41 问第 2 项，劳动者只主张用工之日满一年后二倍工资的，增加一倍的部分不予支持；` +
        `因此被排除的月份：${blockedMonths.join('、')}。` +
        `可主张的替代路径是请求**确认双方为无固定期限劳动合同关系**（法释〔2025〕12号第九条），` +
        `而不是继续主张这段期间的二倍工资。`,
      valueFen: 0,
    });
  } else if (excluded.length > 0) {
    steps.push({
      id: 'excluded',
      title: '窗口外月份（不计入）',
      detail: `${excluded.join('、')}。不在计算窗口内，本项不计——列在这里是为了让对方看到没有漏算。`,
    });
  }

  for (const l of lines) {
    steps.push({
      id: `month-${l.month}`,
      title: `${l.month} 二倍工资差额`,
      detail: `${l.detail}。`,
      valueFen: l.claimableFen,
    });
  }

  if (lines.length > 0) {
    steps.push({
      id: 'shixiao',
      title: '仲裁时效：自主张权利之日向前一年按日计算',
      detail:
        `主张权利之日 ${ymdText(claimedAt)}，向前一年即 ${ymdText(shixiaoFrom)} 起的天数在时效内` +
        `（534 号第 41 问第 5 项：增加一倍的部分属惩罚性赔偿，不是劳动报酬，适用一年普通时效）。` +
        `合计 ${yuan(totalFen)} 元，其中已过时效 ${yuan(expiredFen)} 元，` +
        `时效内可主张 ${yuan(claimableFen)} 元。` +
        `注意：时效抗辩**须由用人单位提出**，仲裁机构和法院不主动适用；` +
        `且有证据证明时效中断（如曾书面主张过）或中止的除外。`,
      valueFen: claimableFen,
    });
  }

  steps.push({
    id: 'amount',
    title: '合计可主张二倍工资差额',
    detail:
      `${yuan(claimableFen)} 元。主张的是**差额**（惩罚性的那一倍），正常一倍工资已随月工资发过；` +
      `请求事项写「支付未订立书面劳动合同二倍工资差额 ${yuan(claimableFen)} 元」。`,
    valueFen: claimableFen,
  });

  const inputs: DoubleWageInputs = Object.freeze({
    scenario: input.scenario,
    anchorDate: input.anchorDate.slice(0, 10),
    contractSignedAt: input.contractSignedAt?.slice(0, 10),
    claimedAt: input.claimedAt.slice(0, 10),
    months: input.months.map((m) => ({ ...m })),
    windowFrom: ymdText(window.from),
    windowTo: ymdText(window.to),
    shixiaoFrom: ymdText(shixiaoFrom),
    minWageFen,
    monthlyPayDays,
  });

  if (expiredFen > 0) flags.push(CALC_FLAG.shuangbeiPartlyExpired);
  flags.push(CALC_FLAG.shuangbeiShixiaoDefense, CALC_FLAG.shuangbeiShixiaoInterrupt);

  const windowText = windowEmpty
    ? '计算窗口为空'
    : `${ymdText(window.from)} 至 ${ymdText(window.to)} 共 ${lines.length} 个计算月`;
  const formula =
    expiredFen > 0
      ? `${windowText}：Σ（各月应付工资 × 1）= ${yuan(totalFen)} 元，` +
        `扣除超时效 ${yuan(expiredFen)} 元 = ${yuan(claimableFen)} 元`
      : `${windowText}：Σ（各月应付工资 × 1）= ${yuan(claimableFen)} 元`;

  return {
    kind: '双倍工资',
    amountFen: claimableFen,
    claimableFen,
    expiredFen,
    formula,
    inputs,
    steps,
    // 逐月循环里可能把同一个 flag（如最低工资兜底）push 多次，去重后交出去。
    flags: [...new Set(flags)],
    basis: SHUANGBEI_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
