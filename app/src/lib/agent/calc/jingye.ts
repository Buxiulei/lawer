// app/src/lib/agent/calc/jingye.ts
// 竞业限制：补偿够不够、违约金离不离谱（北京口径）。
// 口径唯一来源：knowledge/packs/calc/jingye-buchang-weiyuejin.md。
//
// 报数前必须先分清两档效力，这是本公式最容易出错、也最容易把用户带沟里的地方：
//   【可直接判的】30% 下限（法释〔2020〕26号§36）、24 个月上限（劳动合同法§24）；
//   【人社部指引的参考线】50%、违约金 5 倍、提前解除 3 个月（人社厅发〔2025〕40号）——
//   行政指引，仲裁庭无适用义务，是谈判与投诉筹码，不是能判下来的数。
// 所以 amountFen 一律按 **30%** 出数（北京三中院 2026 典型案例·案例四，24 个月期限的案子
// 法院用的仍是 30%）；T > 12 个月时另给一个 50% 档的 negotiation* 数字并打 flag，
// 让 agent 能说清「这一档是谈判目标，不是可主张值」。
//
// 五步：① 条款还生不生效 → ② 月补偿下限 M → ③ 补偿总额 C = M × T →
//       ④ 违约金参考上限 P = 约定补偿总额 × 5 → ⑤ 停付解套 / 中途解约的分手费下限 M × 3。

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

/** 竞业期限上限：24 个月，超出部分无效（劳动合同法§24）。 */
export const JINGYE_MAX_MONTHS = 24;
/** 可直接判的月补偿比例：前 12 个月平均工资的 30%（法释〔2020〕26号§36）。 */
export const JINGYE_RATE_JUDICABLE = 0.3;
/** 人社部指引对 12 个月以上竞业期的参考比例：50%（人社厅发〔2025〕40号§13，非硬标准）。 */
export const JINGYE_RATE_GUIDELINE = 0.5;
/** 违约金参考上限倍数：约定补偿总额的 5 倍（指引§14「一般不宜超过」）。 */
export const JINGYE_PENALTY_CAP_MULTIPLE = 5;
/** 公司中途解除竞业协议的分手费下限月数：3 个月经济补偿（指引§18）。 */
export const JINGYE_EARLY_RELEASE_MONTHS = 3;

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface NonCompeteInput {
  /**
   * W：劳动合同解除或终止前 12 个月平均**应得工资**（分）——含税、含个人应缴社保公积金部分，
   * 不是基本工资、不是到手（《解答（一）》第 55 条）。公司常拿「基本工资」当基数。
   */
  avgMonthlyWageFen: number;
  /** 协议约定的竞业期限（月）。超过 24 个月的部分无效，本函数按 24 截断。 */
  agreedMonths: number;
  /** 实际履行的月数。给了则与约定孰短（已过的月份按实际履行计）。 */
  actualMonths?: number;
  /** 协议约定的月补偿标准（分）。高于下限的按约定，低于或没约定的按下限。 */
  agreedMonthlyCompFen?: number;
  /** 协议约定的补偿总额（分）——指引§14 的 5 倍线原文分母。不给则按 M×T 推导并打 flag。 */
  agreedTotalCompFen?: number;
  /** 协议约定的违约金（分）。给了才比对 5 倍参考线。 */
  agreedPenaltyFen?: number;
  /**
   * 竞业条款是否生效/有效。缺省 true。
   * 传 false 表示未接触商业秘密、非保密义务人员、或范围地域期限明显不相适应——
   * 条款不生效则无须履行，补偿与违约金一并归零。
   */
  clauseEffective?: boolean;
  /** 公司已实际支付的补偿总额（分）。用于算欠付。 */
  paidCompFen?: number;
  /** 公司已连续停付的月数。 */
  unpaidMonths?: number;
  /** 是否已就停付发出书面催告并留存送达证据。催告过，超 1 个月即可解套；没催告要等超 3 个月。 */
  writtenDemandSent?: boolean;
  /** 覆盖最低工资（分）。 */
  minWageFen?: number;
  inputSources?: Record<string, InputSource>;
}

export interface NonCompeteInputs {
  avgMonthlyWageFen: number;
  agreedMonths: number;
  actualMonths?: number;
  agreedMonthlyCompFen?: number;
  agreedTotalCompFen?: number;
  agreedPenaltyFen?: number;
  clauseEffective: boolean;
  paidCompFen?: number;
  unpaidMonths: number;
  writtenDemandSent: boolean;
  minWageFen: number;
  /** 截断后实际计算用的竞业月数 T。 */
  months: number;
  rate: number;
}

export interface NonCompeteResult extends CalcResult<NonCompeteInputs> {
  /** M：月补偿（分），按 30% 档并经最低工资兜底、约定孰高。 */
  monthlyCompFen: number;
  /** C：补偿总额（分）= M × T（= amountFen）。 */
  totalCompFen: number;
  /** T > 12 时的 50% 档月补偿（分）——谈判目标，非可主张值。 */
  negotiationMonthlyCompFen?: number;
  /** T > 12 时的 50% 档补偿总额（分）。 */
  negotiationTotalCompFen?: number;
  /** P：违约金参考上限（分）= 约定补偿总额（缺则 C）× 5。 */
  penaltyCapFen: number;
  /** 约定违约金相当于补偿总额的多少倍。未给约定违约金时不出。 */
  penaltyMultiple?: number;
  /** 公司中途解约的分手费下限（分）= M × 3。 */
  earlyReleaseFloorFen: number;
  /** 公司欠付的补偿（分）= max(0, C − 已付)。未给已付金额时不出。 */
  arrearsFen?: number;
  /** 停付是否已达到「可不再履行竞业义务」的门槛。 */
  releaseAvailable: boolean;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const JINGYE_PACK = 'calc-jingye-buchang-weiyuejin';

const JINGYE_BASIS: CalcBasis[] = [
  { law: '《中华人民共和国劳动合同法》', article: '第二十三条、第二十四条', packId: JINGYE_PACK },
  {
    law: '法释〔2020〕26号《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》',
    article: '第三十六条',
    packId: JINGYE_PACK,
  },
  {
    law: '法释〔2025〕12号《最高人民法院关于审理劳动争议案件适用法律问题的解释（二）》',
    article: '第十三条至第十五条',
    packId: 'statute-fashi-2025-12-jieshi-2',
  },
  {
    law: '人社厅发〔2025〕40号《关于加强劳动者竞业限制管理指引》（行政指引，非裁判规则）',
    article: '第十三条、第十四条、第十六条至第十八条',
    packId: 'statute-rsty-2025-40-jingye-zhiyin',
  },
];

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 竞业限制的补偿总额、违约金参考上限与解套判断。kind '竞业补偿'（与 claims.kind 对齐）。
 *
 * 月补偿 M 先 round 成分，再乘月数得总额——补偿是按月支付的债，每月各自到期，
 * 不能拿一个未取整的月值直接乘出总额（卡片算例 1 的 125,528.26 即由未取整的月值算得，
 * 按逐月取整口径应为 125,528.16，差 0.10 元，见 __tests__ 内的说明）。
 */
export function calcNonCompeteComp(input: NonCompeteInput): NonCompeteResult {
  if (input.agreedMonths <= 0) throw new Error('agreedMonths 必须为正数');
  if (input.actualMonths !== undefined && input.actualMonths < 0) {
    throw new Error('actualMonths 不得为负');
  }

  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const clauseEffective = input.clauseEffective ?? true;
  const unpaidMonths = input.unpaidMonths ?? 0;
  const writtenDemandSent = input.writtenDemandSent ?? false;

  // T：约定与实际履行孰短，且封顶 24 个月。
  const cappedAgreed = Math.min(input.agreedMonths, JINGYE_MAX_MONTHS);
  const months = Math.min(cappedAgreed, input.actualMonths ?? cappedAgreed);

  const flags: CalcFlag[] = [];
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);

  const steps: CalcStep[] = [];

  // ── 第一步：条款还生不生效 ──
  if (!clauseEffective) {
    flags.push(CALC_FLAG.jingyeClauseIneffective);
    const inputs = freezeInputs(input, {
      clauseEffective,
      unpaidMonths,
      writtenDemandSent,
      minWageFen,
      months,
      rate: JINGYE_RATE_JUDICABLE,
    });
    return {
      kind: '竞业补偿',
      amountFen: 0,
      formula: '竞业条款不生效或无效 → 无须履行竞业义务，补偿与违约金均不计',
      inputs,
      steps: [
        {
          id: 'validity',
          title: '第一步：竞业条款不生效或无效',
          detail:
            `未知悉或未接触商业秘密的（司解二§13①）、仅掌握行业通用知识技能只接触一般经营信息的` +
            `（指引§7③）、范围地域期限与所知秘密明显不相适应的（司解二§13②，超过合理比例部分无效）——` +
            `条款不生效，你自由，补偿也无从谈起。用人单位据此主张违约金的不予支持。`,
          valueFen: 0,
        },
      ],
      flags: [...new Set(flags)],
      basis: JINGYE_BASIS,
      inputSources: input.inputSources,
      calcVersion: CALC_VERSION,
      monthlyCompFen: 0,
      totalCompFen: 0,
      penaltyCapFen: 0,
      earlyReleaseFloorFen: 0,
      releaseAvailable: true,
      arrearsFen: input.paidCompFen === undefined ? undefined : 0,
    };
  }

  if (input.agreedMonths > JINGYE_MAX_MONTHS) {
    flags.push(CALC_FLAG.jingyeTermCapped);
  }
  steps.push({
    id: 'term',
    title: '第一步：条款有效，确定竞业期限 T',
    detail:
      `约定 ${input.agreedMonths} 个月` +
      (input.agreedMonths > JINGYE_MAX_MONTHS
        ? `，超过劳动合同法第二十四条的 24 个月上限，超出部分无效 → 按 ${JINGYE_MAX_MONTHS} 个月计`
        : '') +
      (input.actualMonths !== undefined ? `；实际履行 ${input.actualMonths} 个月，与约定孰短` : '') +
      ` → T = ${months} 个月。`,
  });

  // ── 第二步：月补偿下限 M ──
  flags.push(CALC_FLAG.jingyeRate30Judicable);
  const rateFloorFen = Math.round(input.avgMonthlyWageFen * JINGYE_RATE_JUDICABLE);
  const floorFen = Math.max(rateFloorFen, minWageFen);
  if (rateFloorFen < minWageFen) flags.push(CALC_FLAG.jingyeCompMinWageFloor);
  const monthlyCompFen = Math.max(input.agreedMonthlyCompFen ?? floorFen, floorFen);
  flags.push(CALC_FLAG.jingyeWageInclusiveNoOffset);
  steps.push({
    id: 'monthly',
    title: '第二步：月补偿 M = max(W × 30%, 最低工资)，约定更高的按约定',
    detail:
      `W = ${yuan(input.avgMonthlyWageFen)} 元（解除或终止前 12 个月平均**应得工资**，` +
      `含税含个人应缴社保公积金，不是基本工资也不是到手）。` +
      `W × 30% = ${yuan(rateFloorFen)} 元，与北京最低工资 ${yuan(minWageFen)} 元取高 → ` +
      `下限 ${yuan(floorFen)} 元/月` +
      (rateFloorFen < minWageFen
        ? `（触底：法释〔2020〕26号§36 第 2 款，30% 低于劳动合同履行地最低工资的按最低工资付）`
        : '') +
      `。` +
      (input.agreedMonthlyCompFen === undefined
        ? `协议未约定补偿标准，按下限计。`
        : `协议约定 ${yuan(input.agreedMonthlyCompFen)} 元/月，与下限取高 → ${yuan(monthlyCompFen)} 元/月。`) +
      `在职工资里拆出的「竞业补偿/保密费」不能抵扣离职后的补偿（指引§16）。`,
    valueFen: monthlyCompFen,
  });

  // ── 第三步：补偿总额 C ──
  const totalCompFen = monthlyCompFen * months;
  steps.push({
    id: 'total',
    title: '第三步：补偿总额 C = M × T',
    detail: `${yuan(monthlyCompFen)} × ${months} = ${yuan(totalCompFen)} 元。`,
    valueFen: totalCompFen,
  });

  // 50% 档只在 T > 12 时给，且只作谈判目标——已知北京案例（三中院案例四，2 年期）用的仍是 30%。
  let negotiationMonthlyCompFen: number | undefined;
  let negotiationTotalCompFen: number | undefined;
  if (months > 12) {
    flags.push(CALC_FLAG.jingyeRate50Guideline);
    const guidelineFloorFen = Math.max(
      Math.round(input.avgMonthlyWageFen * JINGYE_RATE_GUIDELINE),
      minWageFen,
    );
    negotiationMonthlyCompFen = Math.max(input.agreedMonthlyCompFen ?? 0, guidelineFloorFen);
    negotiationTotalCompFen = negotiationMonthlyCompFen * months;
    steps.push({
      id: 'negotiation-50',
      title: '（谈判目标）50% 档：人社部指引参考线，不是能判下来的数',
      detail:
        `T = ${months} > 12 个月，人社厅发〔2025〕40号§13 称补偿「一般不宜低于」前 12 个月平均工资的 50%：` +
        `${yuan(negotiationMonthlyCompFen)} 元/月 × ${months} = ${yuan(negotiationTotalCompFen)} 元。` +
        `但指引是行政指引、仲裁庭无适用义务；截至卡片更新日未检索到北京法院按 50% 判付的公开案例，` +
        `北京三中院 2026 典型案例·案例四（2 年期）用的仍是 30%。` +
        `**报数时以 30% 为可主张值，50% 只作为谈判目标提出。**`,
      valueFen: negotiationTotalCompFen,
    });
  }

  // ── 第四步：违约金参考上限 P ──
  flags.push(CALC_FLAG.jingyePenaltyCapAdvisory);
  const penaltyBaseFen = input.agreedTotalCompFen ?? totalCompFen;
  if (input.agreedTotalCompFen === undefined) flags.push(CALC_FLAG.jingyePenaltyBaseDerived);
  const penaltyCapFen = penaltyBaseFen * JINGYE_PENALTY_CAP_MULTIPLE;
  let penaltyMultiple: number | undefined;
  if (input.agreedPenaltyFen !== undefined) {
    penaltyMultiple = penaltyBaseFen === 0 ? Infinity : input.agreedPenaltyFen / penaltyBaseFen;
    if (input.agreedPenaltyFen > penaltyCapFen) flags.push(CALC_FLAG.jingyePenaltyOverCap);
  }
  steps.push({
    id: 'penalty-cap',
    title: '第四步：违约金参考上限 P = 约定补偿总额 × 5',
    detail:
      (input.agreedTotalCompFen === undefined
        ? `协议未约定补偿总额，指引§14 原文的分母是「约定竞业限制经济补偿总额」，` +
          `此处按应付总额 ${yuan(totalCompFen)} 元作参照（推导口径，非指引原文）`
        : `约定补偿总额 ${yuan(input.agreedTotalCompFen)} 元`) +
      ` × 5 = ${yuan(penaltyCapFen)} 元。` +
      (input.agreedPenaltyFen === undefined
        ? ''
        : `协议约定违约金 ${yuan(input.agreedPenaltyFen)} 元，为补偿总额的 ${formatMultiple(penaltyMultiple as number)} 倍` +
          (input.agreedPenaltyFen > penaltyCapFen
            ? `，明显偏离指引 5 倍参考线，是请求调低的有力素材。`
            : `，未超 5 倍参考线。`)) +
      `实际调低仍走司法因素综合衡量（民法典合同编通则解释第 65 条），` +
      `尚未见判决直接援引指引§14 的 5 倍——属参考标尺，非裁判规则。`,
    valueFen: penaltyCapFen,
  });

  // ── 第五步：停付解套 / 中途解约的分手费 ──
  const releaseAvailable = unpaidMonths > (writtenDemandSent ? 1 : JINGYE_EARLY_RELEASE_MONTHS);
  if (releaseAvailable) flags.push(CALC_FLAG.jingyeReleaseAvailable);
  const earlyReleaseFloorFen = monthlyCompFen * JINGYE_EARLY_RELEASE_MONTHS;
  const arrearsFen =
    input.paidCompFen === undefined ? undefined : Math.max(0, totalCompFen - input.paidCompFen);
  steps.push({
    id: 'release',
    title: '第五步：公司停付怎么解套、中途解约拿多少',
    detail:
      `已停付 ${unpaidMonths} 个月，${writtenDemandSent ? '已' : '未'}发出书面催告。` +
      `指引§17：超过 1 个月且经书面提醒仍未付、或超过 3 个月未付的，可不再履行竞业义务 → ` +
      `本次${releaseAvailable ? '已达到' : '尚未达到'}解套门槛` +
      (releaseAvailable
        ? '（同时仍可追索欠付的补偿）。'
        : writtenDemandSent
          ? '，再等一个月即满足。'
          : '。催告是这一步的成败关键：微信 + 邮件 + EMS 三路并发并留存送达证据，' +
            '有催告超 1 个月即可解套，没催告要等到超 3 个月。没催告就直接入职竞对，风险自负。') +
      (arrearsFen === undefined
        ? ''
        : ` 已付 ${yuan(input.paidCompFen as number)} 元，欠付 ${yuan(arrearsFen)} 元。`) +
      ` 指引§18：公司中途要解除竞业协议、协商不成的，按不低于 3 个月经济补偿支付 → ` +
      `分手费下限 = ${yuan(monthlyCompFen)} × 3 = ${yuan(earlyReleaseFloorFen)} 元。` +
      `履行的证明：竞业期内定期打印社保个人权益记录（「北京通—京通」可查）。`,
    valueFen: earlyReleaseFloorFen,
  });

  const inputs = freezeInputs(input, {
    clauseEffective,
    unpaidMonths,
    writtenDemandSent,
    minWageFen,
    months,
    rate: JINGYE_RATE_JUDICABLE,
  });

  return {
    kind: '竞业补偿',
    amountFen: totalCompFen,
    formula:
      `补偿总额 C = max(W × 30%, 最低工资${input.agreedMonthlyCompFen === undefined ? '' : '，约定'}) × T = ` +
      `${yuan(monthlyCompFen)} × ${months} = ${yuan(totalCompFen)} 元` +
      (negotiationTotalCompFen === undefined
        ? ''
        : `（50% 谈判档 ${yuan(negotiationTotalCompFen)} 元）`),
    inputs,
    steps,
    flags: [...new Set(flags)],
    basis: JINGYE_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
    monthlyCompFen,
    totalCompFen,
    negotiationMonthlyCompFen,
    negotiationTotalCompFen,
    penaltyCapFen,
    penaltyMultiple,
    earlyReleaseFloorFen,
    arrearsFen,
    releaseAvailable,
  };
}

function freezeInputs(
  input: NonCompeteInput,
  resolved: Pick<
    NonCompeteInputs,
    'clauseEffective' | 'unpaidMonths' | 'writtenDemandSent' | 'minWageFen' | 'months' | 'rate'
  >,
): Readonly<NonCompeteInputs> {
  return Object.freeze({
    avgMonthlyWageFen: input.avgMonthlyWageFen,
    agreedMonths: input.agreedMonths,
    actualMonths: input.actualMonths,
    agreedMonthlyCompFen: input.agreedMonthlyCompFen,
    agreedTotalCompFen: input.agreedTotalCompFen,
    agreedPenaltyFen: input.agreedPenaltyFen,
    paidCompFen: input.paidCompFen,
    ...resolved,
  });
}

/** 倍数展示：16.404 → '16.4'，整数不带小数。用户听得懂「16 倍多」，听不懂 16.404199。 */
function formatMultiple(multiple: number): string {
  if (!Number.isFinite(multiple)) return '∞';
  return Number.isInteger(multiple) ? String(multiple) : multiple.toFixed(1);
}
