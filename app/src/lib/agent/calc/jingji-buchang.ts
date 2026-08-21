// app/src/lib/agent/calc/jingji-buchang.ts
// 经济补偿金 N / 代通知金 N+1 / 违法解除赔偿金 2N（北京口径）。
// 口径唯一来源：knowledge/packs/calc/jingji-buchang-n.md、calc/daitongzhijin-n1.md，
// 法条原文见 knowledge/packs/statutes/jgf-2024-534-jieda-1.md。改数字前先改卡片。
//
// 三者的关系（算错会让用户在庭上多要或少要一大笔）：
//   · N   —— 第四十六条列举情形下的经济补偿，基数是解除前 12 个月平均**应得**工资。
//   · N+1 —— N 加一个月代通知金。「+1」的基数是**上一个月**工资标准（实施条例第二十条），
//            不是 12 个月平均，两者通常不相等。且**只有第四十条三情形**才有法定「+1」；
//            经济性裁员（第四十一条）法定无「+1」，方案里写的那一个月属协商给付。
//            本文件不做适用性校验——「这个案子该用哪个公式」是 agent 层的判断。
//   · 2N  —— 违法解除赔偿金，按第四十七条口径算出 N 再乘 2，**不再分段**（534 号第 66 问）。
//            2N 与 N、N+1 **不并存**（实施条例第二十五条：付了赔偿金不再付经济补偿）。
//
// 纯函数铁律：无 IO、无 Date.now、无 getDb。社平封顶值与最低工资这类会随年度变的外部数值
// 一律可由入参覆盖，用了内置缺省就打 flag。同输入恒同输出，这样历史结论才可复算。
// 「同输入恒同输出」也包括**不随本机时区变**：日期串一律经 db/time 的 fromSql 按 UTC 解析
// （ADR-002），禁止裸 new Date(串)。理由见 parseDate 上的注释。

import { addMonths, asOrdinal, asUtcMs, parseDate, type Ymd } from './date';
import { yuan } from './format';
import {
  CALC_FLAG,
  CALC_VERSION,
  type CalcBasis,
  type CalcFlag,
  type CalcResult,
  type CalcStep,
  type InputSource,
} from './types';

// ───────────────────────────── 可覆盖的外部数值 ─────────────────────────────

/**
 * 三倍封顶值：47,103.25 元/月。
 * = 北京市 2023 年度**法人单位**从业人员平均工资 188,413 元/年 ÷ 12 × 3（2024-06-19 市统计局发布）。
 * ⚠ 不是社保缴费基数用的「全口径」平均工资，两套数混用会差几十万（见 data-beijing-shepin-fengding）。
 * ⚠ 这是「最新可核实值」，当年度新值可能已发布——用缺省即打 '社平新值待核实'。
 */
export const SANBEI_CAP_FEN_DEFAULT = 4_710_325;

/**
 * 北京市月最低工资：2,540 元/月（京人社劳发〔2025〕7 号，2025-09-01 起执行）。
 * 平均工资低于此数的按此数兜底（见 data-beijing-zuidi-gongzi）。
 */
export const MIN_WAGE_FEN_DEFAULT = 254_000;

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface JingjiBuchangInput {
  /** 解除/终止前 12 个月平均**应得**工资（税前、扣个人社保公积金之前），单位分。 */
  avgMonthlyWageFen: number;
  /** 入职日。'YYYY-MM-DD'，canonical/ISO 时间串亦可（只取日期部分）。 */
  employedFrom: string;
  /** 解除/终止日。同上。 */
  terminatedAt: string;
  /** 覆盖三倍封顶值（分）。不给则用 SANBEI_CAP_FEN_DEFAULT 并打 flag。 */
  sanbeiCapFen?: number;
  /** 覆盖最低工资（分）。不给则用 MIN_WAGE_FEN_DEFAULT。 */
  minWageFen?: number;
  inputSources?: Record<string, InputSource>;
}

export interface NPlus1Input extends JingjiBuchangInput {
  /** 解除前最后一个完整工资月的工资标准（分）。「+1」按它算，不是按 12 个月平均。 */
  lastMonthWageFen: number;
}

/** 归一化后的输入快照：日期截到 'YYYY-MM-DD'，缺省的外部数值已落实为具体数字。 */
export interface JingjiBuchangInputs {
  avgMonthlyWageFen: number;
  employedFrom: string;
  terminatedAt: string;
  sanbeiCapFen: number;
  minWageFen: number;
}

export interface NPlus1Inputs extends JingjiBuchangInputs {
  lastMonthWageFen: number;
}

// ───────────────────────────── 工龄折算 ─────────────────────────────

interface Tenure {
  /** 日历口径的满年、满月、满日。 */
  years: number;
  months: number;
  days: number;
  /** 折算后的补偿月数。 */
  compensationMonths: number;
  /** 余数落在哪一档，null 表示恰满整年无余。 */
  remainderTier: 'roundUpYear' | 'halfMonth' | null;
}

function tenure(employedFrom: string, terminatedAt: string): Tenure {
  const from = parseDate(employedFrom, 'employedFrom');
  const to = parseDate(terminatedAt, 'terminatedAt');
  if (asOrdinal(from) > asOrdinal(to)) {
    throw new Error(`employedFrom(${employedFrom}) 晚于 terminatedAt(${terminatedAt})`);
  }

  // 满月数 = 使「入职日 + k 个月 ≤ 解除日」成立的最大 k。先按年月差估一个 k，
  // 估高了（入职日的「日」比解除日大）就退一个月，再用锚点日算余下的满日数。
  let wholeMonths = (to.y - from.y) * 12 + (to.m - from.m);
  if (asUtcMs(addMonths(from, wholeMonths)) > asUtcMs(to)) wholeMonths -= 1;
  const years = Math.floor(wholeMonths / 12);
  const months = wholeMonths % 12;
  const days = (asUtcMs(to) - asUtcMs(addMonths(from, wholeMonths))) / 86_400_000;

  // 第四十七条第一款：每满一年一个月；六个月以上不满一年按一年；不满六个月付半个月。
  // 「恰满六个月」（months===6 且 days===0）落在「六个月以上」这一档，计 1。
  let remainderTier: Tenure['remainderTier'];
  let compensationMonths: number;
  if (months >= 6) {
    remainderTier = 'roundUpYear';
    compensationMonths = years + 1;
  } else if (months > 0 || days > 0) {
    remainderTier = 'halfMonth';
    compensationMonths = years + 0.5;
  } else {
    remainderTier = null;
    compensationMonths = years;
  }

  return { years, months, days, compensationMonths, remainderTier };
}

/** 工作年限折算成补偿月数（第四十七条第一款）。非法日期或入职晚于解除日均抛错。 */
export function tenureToMonths(employedFrom: string, terminatedAt: string): number {
  return tenure(employedFrom, terminatedAt).compensationMonths;
}

// ───────────────────────────── 展示 ─────────────────────────────

const tenureText = (t: Tenure) => `${t.years} 年 ${t.months} 个月${t.days > 0 ? ` ${t.days} 天` : ''}`;

// ───────────────────────────── 法律依据 ─────────────────────────────

const N_PACK = 'calc-jingji-buchang-n';
const LHTF = '《中华人民共和国劳动合同法》';
const TIAOLI = '《中华人民共和国劳动合同法实施条例》';
const JGF534 =
  '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》';
const JGF534_PACK = 'statute-jgf-2024-534-jieda-1';

const N_BASIS: CalcBasis[] = [
  { law: LHTF, article: '第四十六条', packId: N_PACK },
  { law: LHTF, article: '第四十七条', packId: N_PACK },
  { law: TIAOLI, article: '第二十七条', packId: N_PACK },
  { law: JGF534, article: '第55问', packId: JGF534_PACK },
];

// ───────────────────────────── N ─────────────────────────────

/** N 的中间量，N+1 与 2N 共用。 */
interface NCore {
  inputs: JingjiBuchangInputs;
  tenure: Tenure;
  /** 封顶/兜底后实际采用的月数与基数。 */
  months: number;
  baseFen: number;
  amountFen: number;
  flags: CalcFlag[];
  steps: CalcStep[];
  /** 算式中「基数 × 月数」这一段，N+1/2N 拿去拼自己的算式。 */
  coreFormula: string;
  /** 触发的特殊档位注解，如「（三倍封顶+12年上限）」，没有则为空串。 */
  note: string;
}

function computeN(input: JingjiBuchangInput): NCore {
  const sanbeiCapFen = input.sanbeiCapFen ?? SANBEI_CAP_FEN_DEFAULT;
  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const t = tenure(input.employedFrom, input.terminatedAt);

  const inputs: JingjiBuchangInputs = Object.freeze({
    avgMonthlyWageFen: input.avgMonthlyWageFen,
    employedFrom: input.employedFrom.slice(0, 10),
    terminatedAt: input.terminatedAt.slice(0, 10),
    sanbeiCapFen,
    minWageFen,
  });

  const rawMonths = t.compensationMonths;
  const wage = input.avgMonthlyWageFen;
  const flags: CalcFlag[] = [];
  if (t.remainderTier) flags.push(CALC_FLAG[t.remainderTier]);

  // 第四十七条第二款：超三倍则「基数按三倍、年限最高十二年」两限捆绑触发，不能只取其一。
  let months = rawMonths;
  let baseFen: number;
  let baseDetail: string;
  const notes: string[] = [];
  if (wage > sanbeiCapFen) {
    baseFen = sanbeiCapFen;
    months = Math.min(rawMonths, 12);
    baseDetail =
      `月平均应得工资 ${yuan(wage)} 元 > 三倍封顶 ${yuan(sanbeiCapFen)} 元/月` +
      ` → 基数按封顶值 ${yuan(sanbeiCapFen)} 元；同时补偿年限最高 12 年（两限捆绑），` +
      `补偿月数由 ${rawMonths} 调整为 ${months}。`;
    if (rawMonths > 12) {
      flags.push(CALC_FLAG.twelveYearCap);
      notes.push('三倍封顶+12年上限');
      // 断崖：工资跨过三倍线后总额反而低于未封顶时的算法结果——工龄超 12 年才可能出现。
      // 谈判时要留意公司是否故意把最后 12 个月的工资结构顶过线。
      if (wage * rawMonths > sanbeiCapFen * months) {
        flags.push(CALC_FLAG.sanbeiCliff);
      }
    } else {
      notes.push('三倍封顶');
    }
  } else if (wage < minWageFen) {
    baseFen = minWageFen;
    baseDetail =
      `月平均应得工资 ${yuan(wage)} 元 < 北京市最低工资 ${yuan(minWageFen)} 元/月` +
      ` → 基数按最低工资 ${yuan(minWageFen)} 元，补偿年限无上限。`;
    flags.push(CALC_FLAG.minWageFloor);
    // 触底行的基数就是最低工资本身——用的还是内置缺省时必须亮牌（北京最低工资年度调整，
    // 缺省过期即金额直接算错）。注入当前值归工具层（tools.ts 读 data-beijing-zuidi-gongzi 的
    // facts，issue #41）；本 flag 是注入缺位时的最后一道提示。
    if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);
    notes.push('最低工资兜底');
  } else {
    baseFen = wage;
    baseDetail =
      `月平均应得工资 ${yuan(wage)} 元 ≤ 三倍封顶 ${yuan(sanbeiCapFen)} 元/月` +
      ` → 基数按实际平均工资 ${yuan(wage)} 元，补偿年限无上限。`;
  }

  if (input.sanbeiCapFen === undefined) flags.push(CALC_FLAG.capUnverified);

  // 全程保留浮点（月数可能是 .5），只在这里取整一次。
  const amountFen = Math.round(baseFen * months);
  const note = notes.length > 0 ? `（${notes.join('，')}）` : '';
  const coreFormula = `${yuan(baseFen)} × ${months}`;

  const remainder = `余 ${t.months} 个月${t.days > 0 ? ` ${t.days} 天` : ''}`;
  const remainderText =
    t.remainderTier === 'roundUpYear'
      ? `${remainder}，满六个月不满一年按一年计 1 个月`
      : t.remainderTier === 'halfMonth'
        ? `${remainder}，不满六个月计 0.5 个月`
        : '恰满整年，无余数';

  const steps: CalcStep[] = [
    {
      id: 'tenure',
      title: '工作年限折算补偿月数',
      detail:
        `${inputs.employedFrom} 至 ${inputs.terminatedAt}，工作 ${tenureText(t)}；` +
        `满 ${t.years} 年计 ${t.years} 个月，${remainderText} → 补偿月数 ${rawMonths}。`,
    },
    {
      id: 'base',
      title: '确定计算基数（解除前 12 个月平均应得工资）',
      detail: baseDetail,
      valueFen: baseFen,
    },
    {
      id: 'amount',
      title: '计算经济补偿金 N',
      detail: `${coreFormula} = ${yuan(amountFen)} 元。`,
      valueFen: amountFen,
    },
  ];

  return { inputs, tenure: t, months, baseFen, amountFen, flags, steps, coreFormula, note };
}

/** 经济补偿金 N（第四十六条列举情形）。 */
export function calcN(input: JingjiBuchangInput): CalcResult<JingjiBuchangInputs> {
  const core = computeN(input);
  return {
    kind: 'N',
    amountFen: core.amountFen,
    formula: `${core.coreFormula} = ${yuan(core.amountFen)} 元${core.note}`,
    inputs: core.inputs,
    steps: core.steps,
    flags: core.flags,
    basis: N_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}

// ───────────────────────────── N+1 ─────────────────────────────

/**
 * N + 代通知金（第四十条三情形，且公司选择「额外支付一个月工资」而非提前三十日通知）。
 *
 * 「+1」按**上一个月**工资标准全额计（实施条例第二十条），不套三倍封顶——封顶的法源是
 * 第四十七条第二款，只约束经济补偿；北京对代通知金无任何裁审明文（534 号全文零命中）。
 * 上月工资低于最低工资是否兜底同样无明文，故本函数对「+1」不做封顶也不做兜底。
 *
 * 适用性不在本函数校验：经济性裁员（第四十一条）法定无「+1」，协商解除（第三十六条）亦然，
 * 违法解除拿 2N 时也没有「+1」。判断该不该调用本函数是 agent 层的事。
 */
export function calcNPlus1(input: NPlus1Input): CalcResult<NPlus1Inputs> {
  const core = computeN(input);
  const amountFen = core.amountFen + input.lastMonthWageFen;

  const steps: CalcStep[] = [
    ...core.steps,
    {
      id: 'daitongzhijin',
      title: '代通知金「+1」（按上一个月工资标准）',
      detail:
        `上一个月工资标准 ${yuan(input.lastMonthWageFen)} 元 × 1 个月 = ` +
        `${yuan(input.lastMonthWageFen)} 元。注意「+1」的基数是上一个月工资，不是 12 个月平均，` +
        `两者通常不相等；代通知金不受三倍封顶约束。`,
      valueFen: input.lastMonthWageFen,
    },
    {
      id: 'total',
      title: '合计 N+1',
      detail: `${yuan(core.amountFen)} + ${yuan(input.lastMonthWageFen)} = ${yuan(amountFen)} 元。`,
      valueFen: amountFen,
    },
  ];

  return {
    kind: 'N+1',
    amountFen,
    formula:
      `${core.coreFormula}${core.note} + ${yuan(input.lastMonthWageFen)}（上月工资）` +
      ` = ${yuan(amountFen)} 元`,
    inputs: Object.freeze({ ...core.inputs, lastMonthWageFen: input.lastMonthWageFen }),
    steps,
    flags: [...core.flags, CALC_FLAG.daitongzhijinNoCap],
    basis: [
      ...N_BASIS,
      { law: LHTF, article: '第四十条', packId: 'calc-daitongzhijin-n1' },
      { law: TIAOLI, article: '第二十条', packId: 'calc-daitongzhijin-n1' },
    ],
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}

// ───────────────────────────── 2N ─────────────────────────────

/**
 * 违法解除赔偿金 2N。
 *
 * 534 号第 66 问：自用工之日起按第四十七条算出经济补偿，再乘以 2，**不再分段**——
 * 基数统一用解除前 12 个月平均工资，2008-01-01 前后分开算两笔的网传说法与北京口径不符。
 * 2N 与 N、N+1 **不并存**（实施条例第二十五条：支付赔偿金后不再支付经济补偿）。
 */
export function calc2N(input: JingjiBuchangInput): CalcResult<JingjiBuchangInputs> {
  const core = computeN(input);
  // 先取整成 N 再翻倍（而非把 ×2 塞进同一次取整），这样 2N 恒等于同输入 calcN 的两倍，
  // 也与 534 号「算出经济补偿，再乘以 2」的表述一致。
  const amountFen = core.amountFen * 2;

  return {
    kind: '2N',
    amountFen,
    formula: `（${core.coreFormula}）× 2 = ${yuan(amountFen)} 元${core.note}`,
    inputs: core.inputs,
    steps: [
      ...core.steps,
      {
        id: 'double',
        title: '经济补偿 ×2 得违法解除赔偿金',
        detail:
          `${yuan(core.amountFen)} × 2 = ${yuan(amountFen)} 元。自用工之日起按第四十七条算出的` +
          `经济补偿整体乘 2，不分段；2N 与 N、N+1 不并存。`,
        valueFen: amountFen,
      },
    ],
    flags: core.flags,
    basis: [
      { law: LHTF, article: '第八十七条', packId: N_PACK },
      { law: TIAOLI, article: '第二十五条', packId: N_PACK },
      { law: JGF534, article: '第66问', packId: JGF534_PACK },
      ...N_BASIS,
    ],
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
