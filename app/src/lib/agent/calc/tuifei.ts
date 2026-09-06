// app/src/lib/agent/calc/tuifei.ts
// 预付费服务的退费测算（设计稿 §16 的 calculatorKinds「退费与违约金」）。
// 口径唯一来源：knowledge/packs/counseling/sop/tuifei-zhengyi.md 第 3 步与第 4 步、
// statutes/xbf-26-55-geshi-tiaokuan-chengfa.md（消保法 §26/§55 逐字原文已在卡上）、
// risk/hetong-dingxing.md（合同定性未定，**待律师书面确认**）。
//
// ─────────────────────────────────────────────────────────────
// 【这个算钱器与其它几个最大的不同：它不产出一个数，它产出一个区间】
//
// 别的公式（N、双倍工资、加班费…）都有一个法定算法，算出来的就是能主张的那个数。
// 退费没有：合同**定性**本身还没有定论（委托合同 vs 服务合同），而定性直接决定用哪条公式。
// SOP 卡第 3 步写的是「算两条线，给区间，不给单一数字……给单一数字就是替律师下了定性结论」。
//
// 所以本函数：
//   ① 三条口径**各自出数**（合同约定 / 未完成次数比例 / 已提供服务对价对照），
//   ② 汇成一个区间 [下限, 上限]，`amountFen` 取**上限**——
//      对我方（咨询师/机构）最不利的那一端。取不准时偏向报警，不偏向让人安心；
//   ③ 消保法 §55 的三倍惩罚性赔偿**单独放在 punitiveRisk 里，不进 amountFen、不进区间**，
//      且逐字标明它是「风险测算」不是「结论」：它的前提是先认定**欺诈行为**，
//      举证责任在对方，而这件事不是一个算式能定的。
//
// 【把三倍并进金额会发生什么】用户看到一个"要赔 X 万"的总数，据此去谈判甚至主动加价，
// 而对方可能根本举不出欺诈的证。一个我们算出来的数字，替对方把主张抬高了。
// ─────────────────────────────────────────────────────────────

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

// ───────────────────────────── 常量 ─────────────────────────────

/** 消保法 §55 第一款：增加赔偿的金额为价款或费用的**三倍**。 */
export const XBF_PUNITIVE_MULTIPLE = 3;
/** 消保法 §55 第一款：增加赔偿的金额**不足五百元的，为五百元**（500 元 = 50000 分）。 */
export const XBF_PUNITIVE_FLOOR_FEN = 50_000;

/**
 * 合同里那条退费条款长什么样。**「没约定」与「约定退 0」是两件事**：
 * 前者是这条口径根本出不了数（该说"合同里没有这一条"），后者是约定了一个我方主张的数
 * 而它可能踩中消保法 §26 第三款直接无效。合并成一个 0 的形态是——
 * 用户以为合同白纸黑字写着不用退，而实际上是我们把"没写"当成了"写了不退"。
 */
export type RefundClause =
  /** 合同没有可算的退费条款（或压根没有书面合同）。此口径不出数。 */
  | { kind: '未约定' }
  /** 「一经缴费概不退还」「疗程未完成不予退费」这类。按约定退 0，但同时打 §26 风险 flag。 */
  | { kind: '概不退费' }
  /** 已完成部分照扣，剩余部分再按一个比例扣违约金。rateBp = 万分比（如 2000 = 20%）。 */
  | { kind: '按比例扣违约金'; rateBp: number }
  /** 已完成部分照扣，再扣一笔固定违约金（分）。 */
  | { kind: '扣固定违约金'; penaltyFen: number };

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface RefundInput {
  /** 对方**已实付**的总额（分）。这是三条口径共同的分子来源，也是 §55 三倍的基数上限。 */
  totalPaidFen: number;
  /** 合同约定的总次数。 */
  sessionsTotal: number;
  /** 已完成（已实际提供服务）的次数。 */
  sessionsUsed: number;
  /**
   * 单次价格（分）。**与 已付÷总次数 可以不相等**——打包价有折扣时两者有差额，
   * 而那个差额正是两条算法给出不同数字的原因，必须算出来讲清（SOP 第 3 步「差异原因」）。
   */
  unitPriceFen: number;
  /** 合同里那条退费条款。不给按「未约定」处理。 */
  clause?: RefundClause;
  /**
   * §55 三倍的基数按哪一段算，取值是**区间的两端**，不是一个结论：
   * 条文写的是「购买商品的价款或者接受服务的费用」，而"涉欺诈的是全部服务还是某一段"
   * 这件事本身有争议。不给时按 [未完成部分对应费用, 已付总额] 取区间。
   */
  punitiveBaseLowFen?: number;
  punitiveBaseHighFen?: number;
  inputSources?: Record<string, InputSource>;
}

export interface RefundInputs {
  totalPaidFen: number;
  sessionsTotal: number;
  sessionsUsed: number;
  unitPriceFen: number;
  clause: RefundClause;
  /** 未完成次数 = 总次数 − 已完成次数（下限 0）。 */
  sessionsUnused: number;
}

/** §55 三倍惩罚性赔偿的**风险区间**。不是能主张的数，也不是我方一定要赔的数。 */
export interface PunitiveRisk {
  /** 区间下限（分），已过五百元下限。 */
  lowFen: number;
  /** 区间上限（分）。 */
  highFen: number;
  /** 是否有一端被五百元下限顶上来（§55「增加赔偿的金额不足五百元的，为五百元」）。 */
  floorApplied: boolean;
  /** 逐字对外的那句纪律。这一段的作用全在这句话上，数字只是它的适用范围。 */
  note: string;
}

export interface RefundResult extends CalcResult<RefundInputs> {
  /** 口径一：按合同约定。**合同没有可算条款时是 null，不是 0**（见 RefundClause 头注释）。 */
  byContractFen: number | null;
  /** 口径二：按未完成次数比例 = 已付 × 未完成 ÷ 总次数。 */
  byUnusedRatioFen: number;
  /** 口径二的对照线：已付 − 已完成次数 × 单次价格（SOP 第 3 步「线一：已提供服务对价」）。 */
  byDeliveredValueFen: number;
  /** 退费区间下限（分）：三条口径里算得出来的那几条取最小。 */
  rangeLowFen: number;
  /** 退费区间上限（分）：同上取最大。`amountFen` 取的就是它。 */
  rangeHighFen: number;
  /** 口径三：消保法 §55 三倍惩罚性赔偿的**风险区间**，独立于退费，不并进 amountFen。 */
  punitiveRisk: PunitiveRisk;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const TUIFEI_SOP_PACK = 'sop-tuifei-zhengyi';
const XBF_PACK = 'statute-xbf-26-55-geshi-tiaokuan-chengfa';
const WEITUO_PACK = 'statute-mfd-933-weituo-jiechu';

const REFUND_BASIS: CalcBasis[] = [
  { law: '《中华人民共和国民法典》', article: '第九百三十三条、第九百二十八条', packId: WEITUO_PACK },
  { law: '《中华人民共和国消费者权益保护法》', article: '第二十六条', packId: XBF_PACK },
  { law: '《中华人民共和国消费者权益保护法》', article: '第五十五条第一款', packId: XBF_PACK },
];

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 退费测算。kind '退费'（与 claims.kind 的枚举对齐）。
 *
 * @throws 次数与金额不自洽时抛（已完成 > 总次数、总次数 ≤ 0、金额为负）——
 *   这类输入算出来的每一个数都是错的，静默按 0 兜底的形态是回一个看起来正常的 0。
 */
export function calcRefund(input: RefundInput): RefundResult {
  if (!Number.isInteger(input.sessionsTotal) || input.sessionsTotal <= 0) {
    throw new Error('sessionsTotal（合同约定总次数）必须是正整数');
  }
  if (!Number.isInteger(input.sessionsUsed) || input.sessionsUsed < 0) {
    throw new Error('sessionsUsed（已完成次数）必须是非负整数');
  }
  if (input.sessionsUsed > input.sessionsTotal) {
    throw new Error(
      `已完成次数 ${input.sessionsUsed} 超过约定总次数 ${input.sessionsTotal}——` +
        '两个数至少有一个填错了；按这组数算出来的每一条口径都是错的。',
    );
  }
  if (input.totalPaidFen < 0 || input.unitPriceFen < 0) {
    throw new Error('totalPaidFen 与 unitPriceFen 不得为负');
  }

  const clause: RefundClause = input.clause ?? { kind: '未约定' };
  const sessionsUnused = input.sessionsTotal - input.sessionsUsed;
  const flags: CalcFlag[] = [CALC_FLAG.tuifeiRangeNotSingle, CALC_FLAG.tuifeiContractNatureUndecided];
  const steps: CalcStep[] = [];

  // ── 第一步：已提供服务对价（两条口径共同的中间量） ──
  const deliveredValueFen = input.unitPriceFen * input.sessionsUsed;
  const impliedUnitFen = Math.round(input.totalPaidFen / input.sessionsTotal);
  const packageDiscount = impliedUnitFen !== input.unitPriceFen;
  if (packageDiscount) flags.push(CALC_FLAG.tuifeiPackageDiscount);
  steps.push({
    id: 'delivered',
    title: '第一步：已提供服务对价 = 已完成次数 × 单次价格',
    detail:
      `已付 ${yuan(input.totalPaidFen)} 元，约定 ${input.sessionsTotal} 次，已完成 ${input.sessionsUsed} 次、` +
      `未完成 ${sessionsUnused} 次。已提供服务对价 = ${input.sessionsUsed} × ${yuan(input.unitPriceFen)} = ` +
      `${yuan(deliveredValueFen)} 元。` +
      (packageDiscount
        ? `注意：已付 ÷ 总次数 = ${yuan(impliedUnitFen)} 元，与单次价格 ${yuan(input.unitPriceFen)} 元**不一致**` +
          `（打包价折扣或另收费用），这正是下面两条算法给出不同数字的原因——对外要讲清差异从哪来。`
        : `已付 ÷ 总次数 与单次价格一致，两条算法不会因折扣产生差额。`),
    valueFen: deliveredValueFen,
  });

  // ── 第二步：口径一 —— 按合同约定 ──
  let byContractFen: number | null = null;
  const residualFen = Math.max(0, input.totalPaidFen - deliveredValueFen);
  if (clause.kind === '未约定') {
    flags.push(CALC_FLAG.tuifeiNoAgreedClause);
    steps.push({
      id: 'by-contract',
      title: '口径一（按合同约定）：**本次不出数**',
      detail:
        '合同里没有可算的退费条款（或没有书面合同）。这条口径**不给数字**——' +
        '没约定与约定退 0 是两件事，把"没写"当成"写了不退"是替对方把这一条填上了。' +
        '没有书面合同**不等于没有合同关系**：聊天记录同样可以确认服务合同关系成立，' +
        '所以"我们没签合同"不是抗辩理由，只是证据劣势。',
    });
  } else if (clause.kind === '概不退费') {
    byContractFen = 0;
    flags.push(CALC_FLAG.tuifeiNoRefundClauseRisk);
    steps.push({
      id: 'by-contract',
      title: '口径一（按合同约定）：约定「概不退费」⇒ 0 元，但这条条款本身有被认定无效的风险',
      detail:
        '按字面：退 0 元。**但这是格式条款**，消保法第二十六条三层要逐层自查：' +
        '① 是否以显著方式提请注意并按要求说明；② 是否属于排除或限制对方权利、减轻或免除我方责任；' +
        '③ 含第二款所列内容的，**其内容无效**——不是可撤销，是无效。' +
        '第三层踩中即条款无效，这时坚持该条款只会把争议推向监管投诉。' +
        '所以这条口径给的 0 元**不能当成结论**，它是区间的下限、也是最容易被击穿的那一端。',
      valueFen: 0,
    });
  } else if (clause.kind === '按比例扣违约金') {
    if (!Number.isFinite(clause.rateBp) || clause.rateBp < 0 || clause.rateBp > 10_000) {
      throw new Error('clause.rateBp（违约金比例，万分比）必须在 0—10000 之间');
    }
    byContractFen = Math.round((residualFen * (10_000 - clause.rateBp)) / 10_000);
    steps.push({
      id: 'by-contract',
      title: '口径一（按合同约定）：剩余部分扣违约金比例',
      detail:
        `剩余部分 = 已付 ${yuan(input.totalPaidFen)} − 已提供服务对价 ${yuan(deliveredValueFen)} = ` +
        `${yuan(residualFen)} 元；按约定扣 ${(clause.rateBp / 100).toFixed(2)}% 违约金 ⇒ ` +
        `退还 ${yuan(residualFen)} × (1 − ${(clause.rateBp / 100).toFixed(2)}%) = ${yuan(byContractFen)} 元。` +
        '违约金条款同样过消保法第二十六条那三层——比例过高属"加重对方责任"，可被认定无效。',
      valueFen: byContractFen,
    });
  } else {
    if (!Number.isFinite(clause.penaltyFen) || clause.penaltyFen < 0) {
      throw new Error('clause.penaltyFen（固定违约金，分）不得为负');
    }
    byContractFen = Math.max(0, residualFen - clause.penaltyFen);
    steps.push({
      id: 'by-contract',
      title: '口径一（按合同约定）：剩余部分扣一笔固定违约金',
      detail:
        `剩余部分 ${yuan(residualFen)} 元 − 约定违约金 ${yuan(clause.penaltyFen)} 元 = ` +
        `${yuan(byContractFen)} 元` +
        (residualFen - clause.penaltyFen < 0 ? '（扣光为止，不倒扣）' : '') +
        '。同样过消保法第二十六条三层。',
      valueFen: byContractFen,
    });
  }

  // ── 第三步：口径二 —— 按未完成次数比例 ──
  const byUnusedRatioFen = Math.round((input.totalPaidFen * sessionsUnused) / input.sessionsTotal);
  steps.push({
    id: 'by-unused-ratio',
    title: '口径二（按未完成次数比例）：已付 × 未完成 ÷ 总次数',
    detail:
      `${yuan(input.totalPaidFen)} × ${sessionsUnused} ÷ ${input.sessionsTotal} = ${yuan(byUnusedRatioFen)} 元。` +
      '这一条把打包价的折扣**按比例分摊**到每一次上，对方最常用的就是它。',
    valueFen: byUnusedRatioFen,
  });

  // ── 第四步：口径二的对照线 —— 已提供服务对价法 ──
  const byDeliveredValueFen = residualFen;
  steps.push({
    id: 'by-delivered-value',
    title: '（对照）已提供服务对价法：已付 − 已完成次数 × 单次价格',
    detail:
      `${yuan(input.totalPaidFen)} − ${yuan(deliveredValueFen)} = ${yuan(byDeliveredValueFen)} 元。` +
      (packageDiscount
        ? `与口径二差 ${yuan(Math.abs(byDeliveredValueFen - byUnusedRatioFen))} 元——差额全部来自` +
          `"打包价折扣算在谁头上"：按单次价扣，等于把折扣留给了我方；按比例分摊，等于折扣双方共担。` +
          `这个差额是谈判空间，不是谁算错了。`
        : '单次价与均价一致，本次与口径二同数。'),
    valueFen: byDeliveredValueFen,
  });

  // ── 第五步：汇成区间 ──
  const candidates = [byUnusedRatioFen, byDeliveredValueFen, ...(byContractFen === null ? [] : [byContractFen])];
  const rangeLowFen = Math.min(...candidates);
  const rangeHighFen = Math.max(...candidates);
  steps.push({
    id: 'range',
    title: '第五步：给区间，不给单一数字',
    detail:
      `能算出来的口径共 ${candidates.length} 条 ⇒ 退费区间 ${yuan(rangeLowFen)} — ${yuan(rangeHighFen)} 元。` +
      '**对外只给这个区间 + 每条口径各自的结果 + 差异原因**，不要给一个数：' +
      '合同定性（委托合同 vs 服务合同）直接决定用哪条公式，而定性未经律师书面确认' +
      '（见知识卡 risk-hetong-dingxing）。给单一数字就是替律师下了定性结论。' +
      `amountFen 落的是区间**上限** ${yuan(rangeHighFen)} 元——取不准时偏向对我方最不利的那一端，` +
      '好过让人按一个乐观的数去安排事情。',
    valueFen: rangeHighFen,
  });

  // ── 第六步：口径三 —— 消保法 §55 三倍的**风险**区间 ──
  flags.push(CALC_FLAG.tuifeiPunitiveIsRiskNotConclusion);
  const baseLow = input.punitiveBaseLowFen ?? byUnusedRatioFen;
  const baseHigh = input.punitiveBaseHighFen ?? input.totalPaidFen;
  const rawLow = Math.round(Math.min(baseLow, baseHigh) * XBF_PUNITIVE_MULTIPLE);
  const rawHigh = Math.round(Math.max(baseLow, baseHigh) * XBF_PUNITIVE_MULTIPLE);
  const punitiveLowFen = Math.max(rawLow, XBF_PUNITIVE_FLOOR_FEN);
  const punitiveHighFen = Math.max(rawHigh, XBF_PUNITIVE_FLOOR_FEN);
  const floorApplied = rawLow < XBF_PUNITIVE_FLOOR_FEN || rawHigh < XBF_PUNITIVE_FLOOR_FEN;
  if (floorApplied) flags.push(CALC_FLAG.tuifeiPunitiveFloor500);
  const punitiveNote =
    '这是**风险测算，不是结论，也不是我方要赔的数**：第五十五条的前提是认定经营者有**欺诈行为**，' +
    '举证责任在对方。没有认定欺诈，这一段一分钱都不成立。' +
    '本项**不计入退费金额**，也不要在任何对外文书或谈判报价里把它加进总额——' +
    '把它并进总数等于替对方把主张抬高了一截，而对方可能根本举不出欺诈的证。' +
    '三倍的基数（是全部已付费用还是涉欺诈的那一段）本身有争议，所以这里给的是区间不是一个数。';
  steps.push({
    id: 'punitive-risk',
    title: '口径三（消保法 §55 三倍）：只给风险区间，不给结论',
    detail:
      `基数区间 ${yuan(Math.min(baseLow, baseHigh))} — ${yuan(Math.max(baseLow, baseHigh))} 元，` +
      `× 3 ⇒ ${yuan(punitiveLowFen)} — ${yuan(punitiveHighFen)} 元` +
      (floorApplied ? `（有一端不足五百元，按第五十五条第一款以 500.00 元计）` : '') +
      `。${punitiveNote}` +
      '我方要做的不是算这个数，是让它触发不了：不承诺疗效、不虚构或含糊资质、不虚构从业年限与个案时长。',
    valueFen: punitiveHighFen,
  });

  const inputs: Readonly<RefundInputs> = Object.freeze({
    totalPaidFen: input.totalPaidFen,
    sessionsTotal: input.sessionsTotal,
    sessionsUsed: input.sessionsUsed,
    unitPriceFen: input.unitPriceFen,
    clause,
    sessionsUnused,
  });

  return {
    kind: '退费',
    // 区间上限：这个字段只能装一个数，而"取不准时偏向报警"要求它是最不利的那一端。
    // 真正对外的是 formula 里的整个区间。
    amountFen: rangeHighFen,
    formula:
      `退费区间 ${yuan(rangeLowFen)} — ${yuan(rangeHighFen)} 元` +
      `（按未完成比例 ${yuan(byUnusedRatioFen)}；按已提供服务对价 ${yuan(byDeliveredValueFen)}；` +
      `按合同约定 ${byContractFen === null ? '合同无此条款，不出数' : `${yuan(byContractFen)}`}）` +
      `｜另有消保法§55 三倍**风险区间** ${yuan(punitiveLowFen)} — ${yuan(punitiveHighFen)} 元，` +
      `须先认定欺诈，不计入退费`,
    inputs,
    steps,
    flags: [...new Set(flags)],
    basis: REFUND_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
    byContractFen,
    byUnusedRatioFen,
    byDeliveredValueFen,
    rangeLowFen,
    rangeHighFen,
    punitiveRisk: {
      lowFen: punitiveLowFen,
      highFen: punitiveHighFen,
      floorApplied,
      note: punitiveNote,
    },
  };
}
