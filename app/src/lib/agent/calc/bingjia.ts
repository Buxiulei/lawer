// app/src/lib/agent/calc/bingjia.ts
// 病假工资 / 医疗期工资的差额（北京口径）。
// 口径唯一来源：knowledge/packs/calc/bingjia-gongzi.md（《北京市工资支付规定》第二十一条）。
//
// 规则结构只有一句话：**北京对病假工资不设上限、只设下限**。
//   月病假工资 = max(劳动合同或集体合同约定的标准, 北京最低工资 × 80% = 2,032 元/月)
// 约定低于 2,032 的部分无效、按 2,032 补足；约定高于此数的按约定，公司不能反过来降到 2,032。
//
// 不满整月的按 21.75 折算（534 号第 57 问第 5 项，优先于工资支付规定第四十三条的 20.92，
// 争议见 CALC_FLAG.jiabanDivisorDisputed）——当月其余计薪日仍按正常出勤工资计发，
// 本函数只算病假那一段，两段相加才是当月应发。
//
// 常见坑：公司把病假按事假处理（第二十二条事假可不付工资）——留存病假条、诊断证明、
// 请假审批记录。以及医疗期内以「部门撤销/经济性裁员」为由解除，那是违法解除（§42③ 挡住
// 第 40、41 条），可主张 2N 或继续履行，病假工资差额**并行**主张、不被 2N 吸收。
//
// claims.kind 没有「病假工资」这一项：落库时归 '欠薪'（病假工资是劳动报酬，见卡片参数口径 7）。
// 该映射由 agent 层做，本文件的 kind 如实标 '病假工资'。

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

/** 病假工资下限比例：北京最低工资的 **80%**（工资支付规定第二十一条）。 */
export const BINGJIA_MIN_RATE = 0.8;

/**
 * 不满整月时的日折算分母：21.75（534 号第 57 问第 5 项）。
 * 工资支付规定第四十三条载 20.92，个别单位仍按 20.92 计发（卡片争议点 4），故开放入参覆盖。
 */
export const BINGJIA_MONTHLY_PAY_DAYS_DEFAULT = 21.75;

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface SickLeaveMonth {
  /** 'YYYY-MM'。 */
  month: string;
  /** 该月公司就病假期间实发的金额（分）。 */
  paidFen: number;
  /** 该月病假的计薪日天数。整月病假不用给；给了就按 21.75 折算。 */
  sickPayDays?: number;
}

export interface SickPayInput {
  /** 病假各月的实发明细，按月升序。 */
  months: SickLeaveMonth[];
  /**
   * 劳动合同/集体合同/规章制度约定的月病假工资标准（分）。
   * 约定「按基本工资 70%」这类的，由调用方先折成金额传进来。
   * 不给 = 三处均未约定，按法定下限出数并打 flag（劳动者也可主张按正常工资，见卡片争议点 2）。
   */
  agreedMonthlySickPayFen?: number;
  /** 覆盖最低工资（分）。 */
  minWageFen?: number;
  /** 覆盖日折算分母（缺省 21.75）。 */
  monthlyPayDays?: number;
  inputSources?: Record<string, InputSource>;
}

export interface SickPayInputs {
  months: SickLeaveMonth[];
  agreedMonthlySickPayFen?: number;
  minWageFen: number;
  monthlyPayDays: number;
  /** 法定下限 = 最低工资 × 80%（分）。 */
  floorFen: number;
  /** 实际适用的月病假工资标准（分）。 */
  standardFen: number;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const BINGJIA_PACK = 'calc-bingjia-gongzi';
const BJ_GONGZI = '《北京市工资支付规定》';

const BINGJIA_BASIS: CalcBasis[] = [
  { law: BJ_GONGZI, article: '第二十一条', packId: BINGJIA_PACK },
  { law: BJ_GONGZI, article: '第二十二条', packId: BINGJIA_PACK },
  { law: '《中华人民共和国劳动合同法》', article: '第四十二条第三项', packId: BINGJIA_PACK },
  {
    law: '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》',
    article: '第57问第5项',
    packId: 'statute-jgf-2024-534-jieda-1',
  },
];

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 病假工资差额。kind 用 '病假工资'（落库映射见文件头）。
 *
 * 逐月各自取整成分再加总：一个月一笔账，每月的工资各自到期，某月实发多于应付的不与其他月
 * 抵扣（按月取 max(0, …)，与待岗同口径）。
 */
export function calcSickPay(input: SickPayInput): CalcResult<SickPayInputs> {
  if (input.months.length === 0) throw new Error('months 不能为空');

  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const monthlyPayDays = input.monthlyPayDays ?? BINGJIA_MONTHLY_PAY_DAYS_DEFAULT;
  const floorFen = Math.round(minWageFen * BINGJIA_MIN_RATE);
  const standardFen = Math.max(input.agreedMonthlySickPayFen ?? floorFen, floorFen);

  const parsed = input.months.map((m) => ({ ...m, at: parseMonth(m.month, 'months[].month') }));
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1].at;
    const cur = parsed[i].at;
    if (cur.y * 12 + cur.m <= prev.y * 12 + prev.m) {
      throw new Error(`months 必须按月份升序且不重复：${parsed[i - 1].month} → ${parsed[i].month}`);
    }
  }

  const flags: CalcFlag[] = [
    CALC_FLAG.bingjiaNotPersonalLeave,
    CALC_FLAG.bingjiaMedicalPeriodProtected,
    CALC_FLAG.bingjiaMedicalPeriodLengthUnknown,
    CALC_FLAG.bingjiaStandbyAfterMedicalDisputed,
  ];
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);
  if (input.agreedMonthlySickPayFen === undefined) flags.push(CALC_FLAG.bingjiaNoAgreedStandard);
  if ((input.agreedMonthlySickPayFen ?? 0) < floorFen) flags.push(CALC_FLAG.bingjiaMinFloor);

  const steps: CalcStep[] = [
    {
      id: 'standard',
      title: '月病假工资标准 = max(约定标准, 最低工资 × 80%)',
      detail:
        `法定下限 = 最低工资 ${yuan(minWageFen)} × 80% = ${yuan(floorFen)} 元/月。` +
        (input.agreedMonthlySickPayFen === undefined
          ? `合同、集体合同、规章制度均未约定病假工资标准，本次按法定下限 ${yuan(floorFen)} 元/月出数——` +
            `第二十一条只写「根据约定支付」，未授权单位在无约定时单方降薪，劳动者也可主张按正常工资发放（争议点）。`
          : `约定标准 ${yuan(input.agreedMonthlySickPayFen)} 元/月，` +
            (input.agreedMonthlySickPayFen < floorFen
              ? `低于下限 → 该约定条款无效，按 ${yuan(floorFen)} 元/月补足。`
              : `高于下限 → 按约定 ${yuan(standardFen)} 元/月发放，公司不能反过来降到下限。`)) +
        `北京对病假工资不设上限、只设下限。` +
        `下限 ${yuan(floorFen)} 元是**应发**口径，不含劳动者个人依法缴纳的社保费和住房公积金——` +
        `公司不得把个人缴费部分算进去凑数。`,
      valueFen: standardFen,
    },
  ];

  let amountFen = 0;
  for (const m of parsed) {
    let dueFen = standardFen;
    let dueDetail = `应付 ${yuan(standardFen)} 元`;
    if (m.sickPayDays !== undefined) {
      flags.push(CALC_FLAG.bingjiaPartialMonth);
      flags.push(CALC_FLAG.jiabanDivisorDisputed);
      dueFen = Math.round((standardFen / monthlyPayDays) * m.sickPayDays);
      dueDetail =
        `不满整月，日病假工资 = ${yuan(standardFen)} ÷ ${monthlyPayDays} = ` +
        `${(standardFen / monthlyPayDays / 100).toFixed(4)} 元，` +
        `× ${m.sickPayDays} 个病假计薪日 = ${yuan(dueFen)} 元（当月其余计薪日另按正常出勤工资计发）`;
    }

    const diffFen = Math.max(0, dueFen - m.paidFen);
    amountFen += diffFen;
    steps.push({
      id: `month-${m.month}`,
      title: monthText(m.at),
      detail:
        `${dueDetail}，实发 ${yuan(m.paidFen)} 元，差额 ${yuan(diffFen)} 元` +
        (dueFen < m.paidFen ? `（实发多于应付，本月差额记 0，不与其他月抵扣）` : '') +
        '。',
      valueFen: diffFen,
    });
  }

  steps.push({
    id: 'amount',
    title: '合计可索赔病假工资差额',
    detail:
      `Σ（各月应付 − 各月实发）= ${yuan(amountFen)} 元。` +
      `病假工资是劳动报酬，欠付可依《劳动合同法》第三十八条第二项主张被迫解除并要求 N；` +
      `劳动关系存续期间不受一年仲裁时效限制（关系终止后一年内提出）。` +
      `另注意：医疗期内公司不得依第四十条、第四十一条解除（第四十二条第三项），` +
      `医疗期内以「部门撤销、经济性裁员」为由解除的属违法解除，可主张 2N 或继续履行，` +
      `病假工资差额并行主张、不因主张 2N 而被吸收；但第四十二条挡不住第三十九条（严重违纪等），` +
      `病假期间仍要按制度履行请假手续，不要失联。`,
    valueFen: amountFen,
  });

  const inputs: SickPayInputs = Object.freeze({
    months: input.months.map((m) => ({ ...m })),
    agreedMonthlySickPayFen: input.agreedMonthlySickPayFen,
    minWageFen,
    monthlyPayDays,
    floorFen,
    standardFen,
  });

  return {
    kind: '病假工资',
    amountFen,
    formula:
      `Σ（各月应付 − 各月实发）= ${yuan(amountFen)} 元` +
      `（月标准 max(约定, 最低工资 ${yuan(minWageFen)} × 80% = ${yuan(floorFen)}) = ${yuan(standardFen)}/月）`,
    inputs,
    steps,
    flags: [...new Set(flags)],
    basis: BINGJIA_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
