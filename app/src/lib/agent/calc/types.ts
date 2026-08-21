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
 * 对不上的三个由 agent 层落库时映射，calc 层只负责把 kind 如实标出来：
 *   '待岗工资'   → '欠薪'（待岗期间的工资差额本质是未足额支付劳动报酬）
 *   '病假工资'   → '欠薪'（病假工资是劳动报酬，见 calc-bingjia-gongzi 参数口径 7）
 *   '加付赔偿金' → '其他'（行政程序产生的惩罚性加付，不是工资，也不随本金一起在仲裁主张）
 */
export type CalcKind =
  | 'N'
  | 'N+1'
  | '2N'
  | '年假'
  | '双倍工资'
  | '加班费'
  | '待岗工资'
  | '病假工资'
  | '竞业补偿'
  | '加付赔偿金'
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

  // ── 拖欠工资的加付赔偿金（calc-tuoqian-jiafu-peichang） ──
  /** 恒发：加付赔偿金以「行政责令 + 逾期不付」为构成要件，启动主体是劳动监察不是仲裁委（§85 句式）。 */
  tuoqianAdminPrerequisite: '加付赔偿金须先经劳动监察责令（行政前置）',
  /** 恒发：534 号《解答（一）》第 6 问——仲裁不予受理、法院裁定驳回，入场券是指令书 + 逾期证据。 */
  tuoqianNotArbitrable: '仲裁不受理加付赔偿金请求，须提交指令书+逾期证据',
  /** 三步（投诉/责令/逾期）缺任一步，加付赔偿金为 0。 */
  tuoqianPrereqUnmet: '行政前置未走完，加付赔偿金为0',
  /** 公司在指令书限期内付清——最常见结局，加付赔偿金为 0，本金提前到手。 */
  tuoqianPaidWithinDeadline: '公司限期内付清，加付赔偿金为0',
  /** 争议点 2：50%—100% 由行政部门在区间内裁量，北京是否有内部执法指引【待核实】。 */
  tuoqianRateDiscretion: '50%—100%由行政部门裁量，无公开执法指引',
  /** 工资支付规定第四十条：奖金、津贴补贴、加班费都在「应付金额」里，只按基本工资认账是错的。 */
  tuoqianScopeIncludesBonus: '应付金额含奖金/津贴补贴/加班费，不限基本工资',
  /** 争议点 3：本金已实际支付的，「逾期不支付」不再成立——欠薪一发生就该并行投诉。 */
  tuoqianClaimAfterPrincipalPaid: '本金到手后再主张加付赔偿金难成立，宜尽早并行投诉',

  // ── 竞业限制（calc-jingye-buchang-weiyuejin） ──
  /** 条款不生效/无效（未接触商业秘密、非保密义务人员、范围不相适应），补偿与违约金均不计。 */
  jingyeClauseIneffective: '竞业条款不生效或无效，无需履行',
  /** 约定期限超 24 个月，超出部分无效（劳动合同法§24），本次已按 24 个月截断。 */
  jingyeTermCapped: '竞业期限超24个月部分无效',
  /** 恒发：30% 是可直接判的下限（法释〔2020〕26号§36），本次金额按此出数。 */
  jingyeRate30Judicable: '按30%出数（法释〔2020〕26号§36，可直接判）',
  /** T > 12 时另给 50% 档：人社部指引参考线，仲裁庭无适用义务，只作谈判目标不作可主张值。 */
  jingyeRate50Guideline: '50%系人社部指引参考线，只作谈判目标',
  /** 月补偿的 30% 低于北京最低工资，按最低工资付（法释〔2020〕26号§36 第 2 款）。 */
  jingyeCompMinWageFloor: '月补偿触最低工资兜底',
  /** 约定违约金超过补偿总额的 5 倍参考线（指引§14），是请求调低的素材。 */
  jingyePenaltyOverCap: '约定违约金超指引5倍参考线',
  /** 争议点 2：5 倍线未见判例直接援引，法院调低走民法典合同编通则解释第 65 条的因素衡量。 */
  jingyePenaltyCapAdvisory: '5倍线系行政指引参考，非裁判规则',
  /** 争议点 3：未约定补偿总额时，5 倍线的分母按 M×T 推导（指引原文只写「约定」总额）。 */
  jingyePenaltyBaseDerived: '未约定补偿总额，5倍线分母按应付总额推导',
  /** 指引§17：公司停付达标（催告后超 1 个月，或径直超 3 个月），可不再履行竞业义务。 */
  jingyeReleaseAvailable: '公司停付达标，可不再履行竞业义务',
  /** 指引§16：在职工资里拆出的「竞业补偿/保密费」不能抵扣离职后的补偿。 */
  jingyeWageInclusiveNoOffset: '在职工资含补偿的约定不能抵扣',

  // ── 病假工资（calc-bingjia-gongzi） ──
  /** 约定标准低于（或没有约定）最低工资 80%，按 2,032 元下限补足（工资支付规定第二十一条）。 */
  bingjiaMinFloor: '按最低工资80%下限补足',
  /** 争议点 2：合同/集体合同/规章制度均未约定标准，本次按法定下限出数，可主张按正常工资。 */
  bingjiaNoAgreedStandard: '未约定病假标准，按下限出数（可主张按正常工资）',
  /** 有不满整月的月份，按 21.75 日折算（折算天数之争见 jiabanDivisorDisputed）。 */
  bingjiaPartialMonth: '不满整月按21.75折算',
  /** 恒发：病假≠事假（第二十二条事假可不付工资），须留存病假条、诊断证明、请假审批。 */
  bingjiaNotPersonalLeave: '病假≠事假，须留存病假条与诊断证明',
  /** 恒发：医疗期内不得依第 40、41 条解除（劳动合同法§42③），违者可主张 2N 或继续履行。 */
  bingjiaMedicalPeriodProtected: '医疗期内不得依第40/41条解除',
  /** 恒发·争议点 1：劳部发〔1994〕479 号档次表未核实，只能说「3—24 个月按工龄分档」。 */
  bingjiaMedicalPeriodLengthUnknown: '医疗期档次表待核实，只能说3—24个月',
  /** 恒发·争议点 3：医疗期满后转按待岗生活费（70%）发放是否合法，实践有争议。 */
  bingjiaStandbyAfterMedicalDisputed: '医疗期满转待岗70%是否合法存争议',
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
