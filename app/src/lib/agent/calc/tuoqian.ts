// app/src/lib/agent/calc/tuoqian.ts
// 拖欠工资的加付赔偿金 50%—100%（北京口径）。
// 口径唯一来源：knowledge/packs/calc/tuoqian-jiafu-peichang.md（《劳动合同法》第八十五条、
// 《北京市工资支付规定》第三十五条）。
//
// 这个公式最重要的部分不是那个乘法，是**三步前置**：
//   第 1 步 向用人单位所在地劳动监察大队投诉
//   第 2 步 劳动行政部门下达《限期改正/限期支付指令书》
//   第 3 步 用人单位在指定期限内仍不支付
// 三步齐备才产生加付赔偿金，缺一步金额就是 0。第 85 条与北京第 35 条的句式一模一样——
// 「由劳动行政部门责令限期支付……**逾期不支付的**，责令……加付赔偿金」——启动主体是劳动
// 行政部门，不是仲裁委。北京对此另有明文：534 号《解答（一）》第 6 问，劳动者坚持在仲裁中
// 主张加付赔偿金的，**仲裁不予受理、法院裁定驳回起诉**。
//
// 所以本函数的默认结论往往是 0，而这正是要给用户看的：最常见的结局是公司在限期内付清
// （加付为 0，但本金几天内到手），拿到加付赔偿金反而是少数结果。**不要向劳动者承诺
// 「一定能多拿 50%」**——这也是把区间两端都返回、而不是只报一个数的原因。
//
// claims.kind 没有「加付赔偿金」这一项：落库时归 '其他'（这是行政程序产生的惩罚性加付，
// 既不是工资也不与本金一起在仲裁主张）。该映射由 agent 层做，本文件的 kind 如实标。

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

/** 加付赔偿金比例区间下端：应付金额的 50%（劳动合同法§85 / 北京市工资支付规定§35）。 */
export const JIAFU_RATE_LOW = 0.5;
/** 比例区间上端：应付金额的 100%。区间内取几成由劳动行政部门裁量，法条不给标准。 */
export const JIAFU_RATE_HIGH = 1;

// ───────────────────────────── 入参与快照 ─────────────────────────────

/**
 * 「应付金额」的四类（第 85 条第 1—4 项）。选类别不只是打标签：类别决定援引第几项，
 * 也决定 basis 里要不要挂北京第 35 条（第 35 条覆盖克扣/无故拖欠/拒付加班费/非全日制小时工资）。
 */
export type ArrearsCategory = '劳动报酬' | '最低工资差额' | '加班费' | '经济补偿';

export interface ArrearsItem {
  category: ArrearsCategory;
  /** 明细说明，如「2026-03 至 2026-05 工资」「待岗压薪差额」。进 steps 供逐项质证。 */
  label: string;
  /** 该项应付金额（分）。工资差额、加班费、N 等本金，不含加付部分。 */
  amountFen: number;
}

export interface ArrearsPenaltyInput {
  /** 应付金额的分项明细。奖金、津贴补贴、加班费都算在内（工资支付规定第四十条）。 */
  items: ArrearsItem[];
  /** 第 1 步：是否已向劳动监察大队投诉。 */
  complaintFiled: boolean;
  /** 第 2 步：劳动行政部门是否已下达限期支付/限期改正指令书。 */
  orderIssued: boolean;
  /** 第 3 步：用人单位是否在指令书指定的期限内仍未支付。 */
  overdueUnpaid: boolean;
  /** 覆盖比例区间下端（缺省 50%）。 */
  rateLow?: number;
  /** 覆盖比例区间上端（缺省 100%）。 */
  rateHigh?: number;
  inputSources?: Record<string, InputSource>;
}

export interface ArrearsPenaltyInputs {
  items: ArrearsItem[];
  complaintFiled: boolean;
  orderIssued: boolean;
  overdueUnpaid: boolean;
  rateLow: number;
  rateHigh: number;
  principalFen: number;
}

/**
 * 加付赔偿金是个**区间**，不是一个数——比例由劳动行政部门在 50%—100% 内裁量。
 * amountFen 取区间下端（保守可主张值，学 shuangbei 的 claimableFen 口径），
 * 上端与合计另列，agent 报数时必须把两端一起说。
 */
export interface ArrearsPenaltyResult extends CalcResult<ArrearsPenaltyInputs> {
  /** 应付金额本金合计（分），不含加付。仲裁主张的是这一笔。 */
  principalFen: number;
  /** 加付赔偿金下端 = 本金 × 50%（= amountFen）。 */
  penaltyLowFen: number;
  /** 加付赔偿金上端 = 本金 × 100%。 */
  penaltyHighFen: number;
  /** 本金 + 加付下端。 */
  totalLowFen: number;
  /** 本金 + 加付上端。 */
  totalHighFen: number;
  /** 三步前置是否走完。false 时加付两端均为 0。 */
  prerequisiteMet: boolean;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const TUOQIAN_PACK = 'calc-tuoqian-jiafu-peichang';
const BJ_GONGZI = '《北京市工资支付规定》';

const TUOQIAN_BASIS: CalcBasis[] = [
  { law: '《中华人民共和国劳动合同法》', article: '第八十五条', packId: TUOQIAN_PACK },
  { law: BJ_GONGZI, article: '第三十五条', packId: TUOQIAN_PACK },
  // 「工资」的范围：计时/计件工资、奖金、津贴和补贴、加班工资以及特殊情况下支付的工资。
  { law: BJ_GONGZI, article: '第四十条', packId: TUOQIAN_PACK },
  {
    law: '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》',
    article: '第6问',
    packId: 'statute-jgf-2024-534-jieda-1',
  },
];

// ───────────────────────────── 主函数 ─────────────────────────────

const STEP_LABELS = ['向劳动监察大队投诉', '劳动行政部门责令限期支付', '用人单位逾期仍不支付'];

/**
 * 拖欠工资/加班费/经济补偿的加付赔偿金。kind 用 '加付赔偿金'（落库映射见文件头）。
 *
 * 分项各自已是整数分，本金直接累加；加付两端各自 round 一次（比例是区间不是分项，
 * 不存在「先分项乘比例再加总」的问题——行政部门是就应付金额总额裁量一个比例）。
 */
export function calcArrearsPenalty(input: ArrearsPenaltyInput): ArrearsPenaltyResult {
  if (input.items.length === 0) throw new Error('items 不能为空');
  const rateLow = input.rateLow ?? JIAFU_RATE_LOW;
  const rateHigh = input.rateHigh ?? JIAFU_RATE_HIGH;
  if (rateLow > rateHigh) throw new Error(`rateLow 不得大于 rateHigh：${rateLow} > ${rateHigh}`);

  const principalFen = input.items.reduce((sum, it) => sum + it.amountFen, 0);
  const stepsDone = [input.complaintFiled, input.orderIssued, input.overdueUnpaid];
  const prerequisiteMet = stepsDone.every(Boolean);

  const flags: CalcFlag[] = [
    CALC_FLAG.tuoqianAdminPrerequisite,
    CALC_FLAG.tuoqianNotArbitrable,
    CALC_FLAG.tuoqianScopeIncludesBonus,
    CALC_FLAG.tuoqianClaimAfterPrincipalPaid,
  ];

  const steps: CalcStep[] = [
    {
      id: 'principal',
      title: '应付金额（本金）合计',
      detail:
        input.items
          .map((it) => `${it.label}（${it.category}）${yuan(it.amountFen)} 元`)
          .join('；') +
        `。合计 ${yuan(principalFen)} 元。` +
        `「工资」按工资支付规定第四十条含计时/计件工资、奖金、津贴和补贴、加班工资，` +
        `公司只按基本工资认账是错的。`,
      valueFen: principalFen,
    },
    {
      id: 'prerequisite',
      title: '三步行政前置核查',
      detail:
        stepsDone.map((ok, i) => `${STEP_LABELS[i]}：${ok ? '已完成' : '未完成'}`).join('；') +
        `。` +
        (prerequisiteMet
          ? `三步齐备，加付赔偿金成立。`
          : `缺${STEP_LABELS.filter((_, i) => !stepsDone[i]).join('、')}这一步，加付赔偿金为 0。`) +
        `加付赔偿金的启动主体是劳动行政部门（劳动监察），不是仲裁委：` +
        `534 号《解答（一）》第 6 问明确，劳动者坚持在仲裁中主张的，仲裁机构不予受理、法院裁定驳回起诉；` +
        `须提交「限期整改（限期支付）指令书 + 用人单位逾期不履行」两份证据。` +
        `投诉时就要向监察索要指令书的书面件并留存，这是日后唯一的入场券。`,
    },
  ];

  let penaltyLowFen = 0;
  let penaltyHighFen = 0;

  if (prerequisiteMet) {
    penaltyLowFen = Math.round(principalFen * rateLow);
    penaltyHighFen = Math.round(principalFen * rateHigh);
    flags.push(CALC_FLAG.tuoqianRateDiscretion);
    steps.push({
      id: 'penalty',
      title: '加付赔偿金 = 应付金额 × 50%~100%',
      detail:
        `${yuan(principalFen)} × ${pct(rateLow)}~${pct(rateHigh)} = ` +
        `${yuan(penaltyLowFen)} ~ ${yuan(penaltyHighFen)} 元。` +
        `取几成由劳动行政部门在区间内裁量，法条只给区间不给标准（北京有无内部执法指引待核实）；` +
        `实务中欠薪时间长、人数多、态度恶劣的取高比例——投诉材料里写明拖欠时长、催讨记录、公司推诿证据。`,
      valueFen: penaltyLowFen,
    });
  } else {
    flags.push(CALC_FLAG.tuoqianPrereqUnmet);
    // 三步里前两步走完只差「逾期」，等于公司在限期内付清了——卡片例 2，最常见的结局。
    const paidInTime = input.complaintFiled && input.orderIssued && !input.overdueUnpaid;
    if (paidInTime) flags.push(CALC_FLAG.tuoqianPaidWithinDeadline);
    steps.push({
      id: 'penalty',
      title: '加付赔偿金 = 0',
      detail: paidInTime
        ? `公司在指令书要求的期限内付清了 ${yuan(principalFen)} 元 → 加付赔偿金 0 元。` +
          `这是最常见的结局，也是行政投诉的真实价值所在：几天内拿到本金，而不是拿到额外的 50%。`
        : `行政前置未走完 → 加付赔偿金 0 元。` +
          `本金 ${yuan(principalFen)} 元仍可走仲裁主张（可强制执行，是主战场）；` +
          `加付赔偿金只能走劳动监察投诉这条并行的路，两条路可以同时走，不要二选一。`,
      valueFen: 0,
    });
  }

  const totalLowFen = principalFen + penaltyLowFen;
  const totalHighFen = principalFen + penaltyHighFen;
  steps.push({
    id: 'amount',
    title: '合计可得（本金 + 加付赔偿金）',
    detail:
      `${yuan(principalFen)} + ${yuan(penaltyLowFen)}~${yuan(penaltyHighFen)} = ` +
      `${yuan(totalLowFen)} ~ ${yuan(totalHighFen)} 元。` +
      `拖欠工资同时是《劳动合同法》第三十八条第二项的被迫解除事由，可解除并主张 N——` +
      `解除理由必须当场写清「因公司未及时足额支付劳动报酬」，事后不能改。`,
    valueFen: totalLowFen,
  });

  const inputs: ArrearsPenaltyInputs = Object.freeze({
    items: input.items.map((it) => ({ ...it })),
    complaintFiled: input.complaintFiled,
    orderIssued: input.orderIssued,
    overdueUnpaid: input.overdueUnpaid,
    rateLow,
    rateHigh,
    principalFen,
  });

  return {
    kind: '加付赔偿金',
    amountFen: penaltyLowFen,
    formula: prerequisiteMet
      ? `加付赔偿金 = ${yuan(principalFen)} × ${pct(rateLow)}~${pct(rateHigh)} = ` +
        `${yuan(penaltyLowFen)} ~ ${yuan(penaltyHighFen)} 元；合计可得 ` +
        `${yuan(totalLowFen)} ~ ${yuan(totalHighFen)} 元`
      : `行政前置未走完，加付赔偿金 = 0 元（本金 ${yuan(principalFen)} 元另行主张）`,
    inputs,
    steps,
    flags: [...new Set(flags)],
    basis: TUOQIAN_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
    principalFen,
    penaltyLowFen,
    penaltyHighFen,
    totalLowFen,
    totalHighFen,
    prerequisiteMet,
  };
}

/** 比例展示：0.5 → '50%'。区间两端都要念给用户听，别出现 0.5 这种机器味的数。 */
function pct(rate: number): string {
  const n = rate * 100;
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}
