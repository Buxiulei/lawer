// app/src/lib/agent/calc/types.ts
// 金额计算器的对外契约（calc_json）。所有公式的返回值都是这一个形状。
//
// 为什么要这么重的返回值：这些数字是要拿到仲裁庭上被对方当庭复算的。只给一个总额，
// 用户既没法自查、也没法在庭上讲清怎么来的。所以每次计算必须同时交出
//   ① amountFen —— 金额一律「分」的整数，不用浮点存钱；
//   ② formula   —— 一行人类可读算式，可直接念给仲裁员听；
//   ③ inputs    —— 归一化后冻结的输入快照，日后复算不依赖当时的调用现场；
//   ④ steps     —— 分步留痕，对方质疑哪一步就翻哪一步；
//   ⑤ basis     —— 每个数字挂到法条，空口无凭的数字不许出现在结论里；
//   ⑥ flags     —— 触发了哪些特殊档位（封顶、兜底、断崖），agent 据此提示用户；
//   ⑦ calcVersion —— 口径会随社平/最低工资年度调整而变，历史结论要能追到当时的口径。

/** 计算口径版本。任何影响金额的口径变更都要抬版本号（semver）。 */
export const CALC_VERSION = '1.0.0';

/**
 * 公式种类。留开放联合：后批还要加 2倍工资、加班费、年假折算等，
 * 加的时候不该逼所有 switch 一起改。
 */
export type CalcKind = 'N' | 'N+1' | '2N' | (string & {});

/**
 * 计算过程中触发的特殊档位（集中此处，防拼写漂移——学 GONGDAO_LEDGER_TYPE 范式）。
 * agent 展示金额时逐条转成提示语，用户才知道自己踩在哪条线上。
 */
export const CALC_FLAG = {
  /** 工龄 > 12 年且工资跨过三倍线，封顶后总额反而低于「工资恰好等于封顶值」的对照组。 */
  sanbeiCliff: '三倍封顶断崖',
  /** 前 12 个月平均应得工资低于北京最低工资，基数按最低工资算。 */
  minWageFloor: '最低工资兜底',
  /** 用了内置缺省封顶值。北京当年度社平新值可能已发布，引用前须以最新公布值核实。 */
  capUnverified: '社平新值待核实',
  /** 工资超三倍封顶时年限最高 12 年（第四十七条第二款两限捆绑），本次实际削减了月数。 */
  twelveYearCap: '12年上限已触发',
  /** 工龄余数不满 6 个月，该段按半个月计。 */
  halfMonth: '不满六个月按半月',
  /** 工龄余数满 6 个月不满 1 年，该段按 1 年计。 */
  roundUpYear: '满六个月不满一年按一年',
  /**
   * 信息性（恒随 N+1 给出）：「+1」按实施条例第二十条以上月工资全额计，不套三倍封顶——
   * 封顶法源（第四十七条第二款）只约束经济补偿，北京对代通知金无裁审明文（534 号全文零命中）。
   * 当庭或谈判被质疑时，agent 凭此 flag 直接给出口径出处。
   */
  daitongzhijinNoCap: '代通知金不适用三倍封顶（北京无明文口径）',
} as const;
export type CalcFlag = (typeof CALC_FLAG)[keyof typeof CALC_FLAG];

/** 单个输入的可信度——agent 展示金额时要说明哪些数还只是用户自述、需要补证据。 */
export type InputSource = '用户自述' | '证据佐证' | '系统默认';

/** 一步计算留痕。valueFen 只在该步产出金额时给。 */
export interface CalcStep {
  id: string;
  title: string;
  detail: string;
  valueFen?: number;
}

/** 法律依据。packId 指向 knowledge/packs 下的卡片 id，便于 agent 回溯原文。 */
export interface CalcBasis {
  law: string;
  article: string;
  packId?: string;
}

export interface CalcResult<TInputs extends object = object> {
  kind: CalcKind;
  /** 金额，单位「分」。整数，全流程只在最终值处 Math.round 一次。 */
  amountFen: number;
  /** 一行人类可读算式，元为单位、千分位、两位小数。 */
  formula: string;
  /** 归一化后的输入快照，已冻结。 */
  inputs: Readonly<TInputs>;
  steps: CalcStep[];
  flags: CalcFlag[];
  basis: CalcBasis[];
  /** 各输入的来源，由调用方透传（未给则由 agent 层按默认口径提示）。 */
  inputSources?: Record<string, InputSource>;
  calcVersion: string;
}
