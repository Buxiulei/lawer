// app/src/lib/agent/calc/daigang.ts
// 待岗/停工停产期间的工资差额（北京口径）。
// 口径唯一来源：knowledge/packs/calc/daigang-gongzi.md（《北京市工资支付规定》第二十七条）。
//
// 分两段，段与段之间差的是整整一个数量级：
//   【第 1 个工资支付周期内】按**提供正常劳动的工资**全额付——是全额，不是最低工资、更不是 70%。
//   【超过第 1 个周期后】
//       情形 A 仍提供劳动（哪怕只是居家值守、零星工单）→ 按双方新约定标准，且 ≥ 最低工资；
//       情形 B 单位没有安排工作（纯待岗）      → 基本生活费 ≥ 最低工资 × 70%。
//   A 与 B 的分界是「单位有没有安排工作」，不是「人在不在岗」——每天打卡待命、随时响应消息的，
//   应主张走 A 档。这一个事实点在北京现行最低工资下就是 762 元/月的差别。
//
// 另有一条常见的、金额差最大的分支：公司正常经营，只把个别员工单独「待岗」——那不是第二十七条
// 说的「停工、停业」，第二十七条根本不适用，应按劳动合同约定**全额**支付（入参 genuineStoppage=false）。
// 裁员场景里「先待岗压薪、再谈解除」还会顺带压低 N 的基数（解除前 12 个月平均工资），
// 待岗当月就该书面异议，别等谈解除时才提。
//
// claims.kind 没有「待岗工资」这一项：落库时归 '欠薪'（待岗期间的工资差额本质是未足额支付
// 劳动报酬）。该映射由 agent 层做，本文件的 kind 如实标 '待岗工资'。

import { monthText, parseMonth } from './date';
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

/** 基本生活费下限比例：最低工资的 **70%**（工资支付规定第二十七条）。 */
export const DAIGANG_LIVING_ALLOWANCE_RATE = 0.7;

/**
 * 不满整月时的日折算分母：21.75（534 号第 57 问第 5 项，优先于工资支付规定第四十三条的 20.92，
 * 见卡片争议点 3）。
 */
export const DAIGANG_MONTHLY_PAY_DAYS_DEFAULT = 21.75;

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface StandbyMonth {
  /** 'YYYY-MM'。第一个月即「第 1 个工资支付周期」（按月发薪）。 */
  month: string;
  /** 该月公司实发（分）。 */
  paidFen: number;
  /** 该月只待岗了一部分时给计薪日数，按 21.75 折算；整月不用给。 */
  payDays?: number;
}

export interface StandbyWageInput {
  /** 提供正常劳动时的全额月工资（分）：含岗位工资、绩效、津贴补贴等固定发放项。 */
  normalMonthlyWageFen: number;
  /** 待岗各月的实发明细，按月升序。第一个月按第 1 个工资支付周期处理。 */
  months: StandbyMonth[];
  /** 超过第 1 个周期后单位是否仍安排劳动：true 走情形 A，false 走情形 B（纯待岗）。 */
  providesLabor: boolean;
  /** 情形 A 下双方新约定的月工资标准（分）。不给则按最低工资这一下限计。 */
  agreedMonthlyWageFen?: number;
  /**
   * 单位是否确实停工、停业。缺省 true。
   * 传 false 表示公司正常经营只对个别员工「待岗」——第二十七条不适用，全程按合同全额支付。
   */
  genuineStoppage?: boolean;
  /** 覆盖最低工资（分）。 */
  minWageFen?: number;
  /** 覆盖日折算分母（缺省 21.75）。 */
  monthlyPayDays?: number;
  inputSources?: Record<string, InputSource>;
}

export interface StandbyWageInputs {
  normalMonthlyWageFen: number;
  months: StandbyMonth[];
  providesLabor: boolean;
  agreedMonthlyWageFen?: number;
  genuineStoppage: boolean;
  minWageFen: number;
  livingAllowanceFen: number;
  monthlyPayDays: number;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const DAIGANG_PACK = 'calc-daigang-gongzi';
const BJ_GONGZI = '《北京市工资支付规定》';

const DAIGANG_BASIS: CalcBasis[] = [
  { law: BJ_GONGZI, article: '第二十七条', packId: DAIGANG_PACK },
  { law: BJ_GONGZI, article: '第二十六条', packId: DAIGANG_PACK },
  {
    law: '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》',
    article: '第57问第5项',
    packId: 'statute-jgf-2024-534-jieda-1',
  },
];

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 待岗/停工停产期间的应付工资与差额。kind 用 '待岗工资'（落库映射见文件头）。
 *
 * 每个月各自取整成分后相加：一个月一笔账，逐月都可能被公司单独拿工资条来质证。
 * 某月实发**多于**应付的不与其他月抵扣（差额按月取 max(0, …)）——每个月的工资是各自到期的债，
 * 公司不能拿 3 月多发的抵 5 月少发的。
 */
export function calcStandbyWage(input: StandbyWageInput): CalcResult<StandbyWageInputs> {
  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const monthlyPayDays = input.monthlyPayDays ?? DAIGANG_MONTHLY_PAY_DAYS_DEFAULT;
  const genuineStoppage = input.genuineStoppage ?? true;
  const livingAllowanceFen = Math.round(minWageFen * DAIGANG_LIVING_ALLOWANCE_RATE);

  if (input.months.length === 0) throw new Error('months 不能为空');
  const parsed = input.months.map((m) => ({ ...m, at: parseMonth(m.month, 'months[].month') }));
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1].at;
    const cur = parsed[i].at;
    if (cur.y * 12 + cur.m <= prev.y * 12 + prev.m) {
      throw new Error(`months 必须按月份升序且不重复：${parsed[i - 1].month} → ${parsed[i].month}`);
    }
  }

  const flags: CalcFlag[] = [];
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);

  // 超周期后的月标准：情形 A 取新约定但不低于最低工资，情形 B 取生活费下限。
  const laterStandardFen = genuineStoppage
    ? input.providesLabor
      ? Math.max(input.agreedMonthlyWageFen ?? minWageFen, minWageFen)
      : livingAllowanceFen
    : input.normalMonthlyWageFen;
  if (genuineStoppage && input.providesLabor && (input.agreedMonthlyWageFen ?? 0) < minWageFen) {
    flags.push(CALC_FLAG.minWageFloor);
  }

  const steps: CalcStep[] = [];
  if (!genuineStoppage) {
    flags.push(CALC_FLAG.daigangNotGenuineStoppage);
    steps.push({
      id: 'not-stoppage',
      title: '单位并未停工停业，第二十七条不适用',
      detail:
        `公司正常经营，只对个别劳动者「待岗」的，不属于第二十七条的「停工、停业」——` +
        `第二十七条针对的是单位（或整体经营单元）停工停业，个别员工无活可干属于用工管理风险，` +
        `应由单位承担，照付劳动合同约定的 ${yuan(input.normalMonthlyWageFen)} 元/月全额工资。` +
        `同时构成未及时足额支付劳动报酬，可依《劳动合同法》第三十八条第二项被迫解除并主张 N。`,
    });
  } else {
    flags.push(CALC_FLAG.daigangFirstCycleDisputed);
    flags.push(
      input.providesLabor ? CALC_FLAG.daigangProvidesLabor : CALC_FLAG.daigangLivingAllowance,
    );
    steps.push({
      id: 'segments',
      title: '分段确定各月应付标准（工资支付规定第二十七条）',
      detail:
        `第 1 个工资支付周期（${parsed[0].month}）内按提供正常劳动的工资全额付：` +
        `${yuan(input.normalMonthlyWageFen)} 元/月——是全额，不是最低工资也不是 70%。` +
        `超过第 1 个周期后：` +
        (input.providesLabor
          ? `单位仍安排劳动（情形 A），按双方新约定标准且不低于最低工资 ${yuan(minWageFen)} 元 → ` +
            `${yuan(laterStandardFen)} 元/月。`
          : `单位没有安排工作（情形 B），按基本生活费下限 = 最低工资 ${yuan(minWageFen)} × 70% = ` +
            `${yuan(livingAllowanceFen)} 元/月。`) +
        `「第 1 个工资支付周期」从停工之日起算还是从下一个完整周期起算，北京无明文（卡片争议点 1），` +
        `本次按入参给的首个月计。`,
    });
  }

  let amountFen = 0;
  for (const [index, m] of parsed.entries()) {
    const isFirstCycle = genuineStoppage && index === 0;
    const standardFen = isFirstCycle ? input.normalMonthlyWageFen : laterStandardFen;

    let dueFen = standardFen;
    let dueDetail = `应付 ${yuan(standardFen)} 元`;
    if (m.payDays !== undefined) {
      flags.push(CALC_FLAG.daigangPartialMonth);
      dueFen = Math.round((standardFen / monthlyPayDays) * m.payDays);
      dueDetail =
        `不满整月，按 ${yuan(standardFen)} ÷ ${monthlyPayDays} × ${m.payDays} 个计薪日 = ` +
        `${yuan(dueFen)} 元`;
    }

    let segment: string;
    if (!genuineStoppage) segment = '按合同全额';
    else if (isFirstCycle) segment = '第 1 个工资支付周期';
    else segment = input.providesLabor ? '超周期·情形A（仍提供劳动）' : '超周期·情形B（纯待岗）';

    const diffFen = Math.max(0, dueFen - m.paidFen);
    amountFen += diffFen;
    steps.push({
      id: `month-${m.month}`,
      title: `${monthText(m.at)}（${segment}）`,
      detail:
        `${dueDetail}，实发 ${yuan(m.paidFen)} 元，差额 ${yuan(diffFen)} 元` +
        (dueFen < m.paidFen ? `（实发多于应付，本月差额记 0，不与其他月抵扣）` : '') +
        '。',
      valueFen: diffFen,
    });
  }

  steps.push({
    id: 'amount',
    title: '合计可索赔工资差额',
    detail:
      `Σ（各月应付 − 各月实发）= ${yuan(amountFen)} 元。` +
      `待岗期间社保公积金仍须正常缴纳，单位不得以待岗为由停缴或降基数；` +
      `最低工资 ${yuan(minWageFen)} 元是扣个人社保公积金**之前**的口径，公司不能把个人缴费部分算进去凑数。`,
    valueFen: amountFen,
  });

  const inputs: StandbyWageInputs = Object.freeze({
    normalMonthlyWageFen: input.normalMonthlyWageFen,
    months: input.months.map((m) => ({ ...m })),
    providesLabor: input.providesLabor,
    agreedMonthlyWageFen: input.agreedMonthlyWageFen,
    genuineStoppage,
    minWageFen,
    livingAllowanceFen,
    monthlyPayDays,
  });

  return {
    kind: '待岗工资',
    amountFen,
    formula:
      `Σ（各月应付 − 各月实发）= ${yuan(amountFen)} 元` +
      (genuineStoppage
        ? `（首个支付周期 ${yuan(input.normalMonthlyWageFen)}/月，之后 ${yuan(laterStandardFen)}/月）`
        : `（未停工停业，全程按合同 ${yuan(input.normalMonthlyWageFen)}/月）`),
    inputs,
    steps,
    flags: [...new Set(flags)],
    basis: DAIGANG_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
