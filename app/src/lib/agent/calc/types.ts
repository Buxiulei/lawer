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
 * 公式种类。留开放联合：后批还要继续加，加的时候不该逼所有 switch 一起改。
 *
 * 字面量与 claims.kind 的枚举对齐（2N|N|N+1|欠薪|年假|加班费|双倍工资|年终奖|竞业补偿|其他）。
 * 唯一对不上的是 '待岗工资'——claims.kind 无此项，落库时归 '欠薪'（待岗期间的工资差额本质是
 * 未足额支付劳动报酬）。该映射是 agent 层的事，calc 层只负责把 kind 如实标出来。
 */
export type CalcKind =
  | 'N'
  | 'N+1'
  | '2N'
  | '年假'
  | '双倍工资'
  | '加班费'
  | '待岗工资'
  | (string & {});

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

  /** 用了内置缺省最低工资。北京最低工资随年度调整，引用前须以现行文号核实。 */
  minWageUnverified: '最低工资缺省值待核实',

  // ── 年假（calc-nianjia-300） ──
  /** 天数按**累计**工作时间定档（含跨单位、视同工作期间），不是本单位司龄。 */
  nianjiaCumulativeTenure: '年假天数按累计工龄（含跨单位）',
  /** 累计工作不满 1 年，不落 5/10/15 任何一档。 */
  nianjiaNoEntitlement: '累计工作不满一年不享受年休假',
  /** 折算后不足 1 整天的部分不支付（实施办法第十二条）。 */
  nianjiaSubDayDropped: '折算不足一整天不支付',
  /** 已安排天数多于折算应休，差额为 0 且多休不再扣回（实施办法第十二条第三款）。 */
  nianjiaOverArranged: '已休多于折算，多休不扣回',
  /** 主张的年度早于「离职当年+上一年度」，按保守口径大概率超时效——提示，不静默剔除。 */
  nianjiaShixiaoConservative: '早于上一年度的年假时效风险高',

  // ── 二倍工资（calc-weiqian-hetong-shuangbei / 534 号第 41 问） ──
  /** 534 号第 41 问第 2 项：用工满一年后视为已订无固定期限合同，该期间二倍工资不予支持。 */
  shuangbeiOneYearBlock: '用工满一年后不支持二倍工资',
  /** 窗口被 11 / 12 个月上限截断。 */
  shuangbeiWindowCapped: '二倍工资窗口已按上限截断',
  /** 窗口两端有不满一月的月份，按该月实际工作日折算（法释〔2025〕12 号第六条）。 */
  shuangbeiPartialMonth: '不满一月按实际工作日折算',
  /** 有月份落在「主张之日向前一年」之外，已单列为超时效金额。 */
  shuangbeiPartlyExpired: '部分月份已过仲裁时效',
  /** 534 号第 41 问末段：时效抗辩须由用人单位提出，仲裁机构/法院不主动适用。 */
  shuangbeiShixiaoDefense: '时效抗辩须用人单位提出，不主动适用',
  /** 同上：有证据证明未超时效（中断/中止）的除外，超时效部分并非必然拿不到。 */
  shuangbeiShixiaoInterrupt: '有证据证明时效中断/中止的除外',
  /** 第 41 问第 4 项：应订无固定期限而不订的，不受十二个月上限限制。 */
  shuangbeiNoTwelveMonthCap: '无固定期限情形不受十二个月上限',

  // ── 加班费（calc-jiabanfei） ──
  /** 日/小时基数折算天数存冲突：534 号第 57 问第 5 项 21.75，工资支付规定第 43 条 20.92。 */
  jiabanDivisorDisputed: '折算天数 21.75/20.92 存争议',
  /** 本次按 20.92 出数（可争取项，非稳拿项）。 */
  jiabanLegacyDivisor: '按 20.92 折算（可争取项）',
  /** 基数口径：合同约定优先，但压到最低工资/低于约定工资标准的可被击破（第 57 问第 1 项）。 */
  jiabanBaseRule: '加班基数约定优先，压低约定可击破',
  /** 法定节假日加班不得以补休替代，必须付 300%（工资支付规定第十四条第三项）。 */
  jiabanHolidayNoSwap: '法定节假日加班不得以补休替代',

  // ── 待岗（calc-daigang-gongzi） ──
  /** 「一个工资支付周期」的起算点北京无明文，本次按入参给的首个月计（争议点 1）。 */
  daigangFirstCycleDisputed: '首个工资支付周期起算点存争议',
  /** 超过首个周期且未安排工作，按最低工资 70% 的基本生活费计。 */
  daigangLivingAllowance: '按最低工资70%计基本生活费',
  /** 超过首个周期但仍提供劳动，下限是最低工资本身而非 70%。 */
  daigangProvidesLabor: '仍提供劳动，下限为最低工资',
  /** 单位并未停工停业（只对个别员工待岗），第二十七条不适用，应按合同全额支付。 */
  daigangNotGenuineStoppage: '未真实停工停业，第27条不适用',
  /** 有不满整月的月份，按 21.75 日折算。 */
  daigangPartialMonth: '不满整月按21.75折算',
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
