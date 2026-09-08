// app/src/lib/agent/gate-chain.ts
// **闸链的固定顺序，写成代码常量而不是散在 orchestrator 的行序里**（设计稿 §4.3）。
//
// 【为什么顺序必须是一份可读的数据，而不只是代码的先后】
// 在此之前，「⑦ 剥引用 排在 ⑧ 补原文 之前」这件事**只存在于 orchestrator.ts 的行序里**。
// 行序是**看不见的契约**：谁往中间插一段、谁把两块调个个儿，都不会有任何东西报错，
// 而后果是确定性的——⑧ 补进去的原文会被 ⑦ 当成"本轮没检索到的逐字引用"剥掉，
// 于是核心位重新变成光秃，且 gate_report 会同时报"补了 1 条"和"剥了 1 处"，
// 两条留痕各自都对，合起来讲的是一件根本没发生的事。
//
// 这份表把顺序变成**可断言的对象**：orchestrator 的实际执行序由 gate-chain.test.ts
// 逐道核对，相邻两闸的相互作用各有一条交互用例（见 §交互用例 一节）。
//
// 【它不是调度器】(刻意的设计取舍) 表只声明顺序与身份，**不驱动执行**。
// 做成调度器要把十道闸的输入输出统一成一个签名，而它们的形态天然不同：
// 有的在流上（⑤⑥）、有的改写正文（⑦⑧⑨）、有的只发 notice 不动正文（④）、
// 有的只在危机轮跑（①②）。硬统一的代价是给每道闸套一层适配壳，
// 而收益只是"看起来像个框架"——顺序的正确性由判据保证，不由抽象保证。
//
// 【共享层纪律】本文件零领域字面量：没有法名、没有金额、没有危机词。
// 每道闸的**领域内容**都在各自的 DomainPack 里，这里只有闸的身份与次序。

/** 闸的稳定 id。改名要同时改 gate-chain.test.ts 与 gate_report 的消费方。 */
export type GateId =
  | 'crisis_opener'
  | 'leverage'
  | 'nbdpsy_pitch'
  | 'precedent_contamination'
  | 'citation_guard'
  | 'statute_guard'
  | 'strip_unsupported_quotes'
  | 'core_article_fallback'
  | 'value_guard'
  | 'practice_boundary';

/**
 * 一道闸对正文做什么。**这一格决定它能不能与相邻闸换位**：
 *   · `rewrite` 改写正文 → 与它相邻的 `rewrite` 闸换位就是行为变更，必须有交互用例；
 *   · `prepend`  在最前面插入确定性文本（危机首段）；
 *   · `observe`  只发 notice、一个字不动（判例污染、光秃条号）。
 */
export type GateEffect = 'prepend' | 'rewrite' | 'observe';

export interface GateSpec {
  /** 链上序号，1 起。与本数组下标 +1 恒等（由判据钉住） */
  order: number;
  id: GateId;
  /** 人读名。出现在 gate_report 与成绩单里 */
  name: string;
  effect: GateEffect;
  /**
   * 这道闸**自己的** notice code。「每道闸只写自己的 notice 通道」——
   * 两道闸共用一个 code，两边的统计就同时失真（教训 11）。
   * `null` = 这道闸不发自己的 notice（① 是确定性首段，没有"开火"这回事）。
   */
  notice: string | null;
  /** `live` = 已接线；`planned` = 顺序已定、实现另属一片（不许假装它在守） */
  status: 'live' | 'planned';
  /**
   * 这道闸**物理上**跑在哪一段：`stream` = 生成循环里逐片过；`post` = 整轮生成完之后。
   *
   * 【为什么表序与源码行序不是同一件事】⑤⑥ 必须在流上——正文是流式下发的，
   * 等整轮跑完再发现编了案号，用户早读进去了（见 citation-guard.ts 文件头）。
   * 于是它们的**调用点**出现在 `runOnce` 里，行号早于 ②③④ 那几道 post 闸，
   * 而**文本流经的先后**仍然是 ②③④ 拿到的已经是过完 ⑤⑥ 的正文。
   * 设计稿 §4.3 的 ①→⑩ 说的是后者。判据按 stage 分段核对，不拿行号硬比。
   */
  stage: 'stream' | 'post';
  /**
   * 在 orchestrator.ts 里定位这道闸调用点的锚串。**判据从这张表读锚**，
   * 不在测试里另抄一份——抄一份的形态是：闸改了名，表和测试各自还留着旧名，
   * 而"实现序与表序一致"照常绿（它比的是两个都不存在的东西）。
   * `planned` 的闸没有锚。
   */
  anchor: string | null;
  /** 它挡的是哪一类失败（设计稿 §1.3 的「失败模式 → 唯一拦截层」） */
  guards: string;
}

/**
 * **闸链的唯一真源**（设计稿 §4.3）。
 *
 * ⑪「争点回声」不在此列：它是**评测侧**的判据，不是产线出口闸。把评测项混进产线闸表，
 * 下一个读表的人会去找它的接线点，找不到就以为漏接了。
 */
export const GATE_CHAIN: readonly GateSpec[] = [
  {
    order: 1,
    id: 'crisis_opener',
    name: '危机首段',
    effect: 'prepend',
    notice: null,
    status: 'live',
    stage: 'post',
    anchor: 'buildCrisisOpener(',
    guards: '情绪危机漏接：确定性词表命中即毫秒级下发资源卡，先于一切、不经模型',
  },
  {
    order: 2,
    id: 'leverage',
    name: '杠杆闸',
    effect: 'rewrite',
    notice: 'EMOTIONAL_LEVERAGE_DETECTED',
    status: 'live',
    stage: 'post',
    anchor: 'applyLeverageGate(',
    guards: '危机轮情感杠杆：剥句，剥空回落确定性安全回复',
  },
  {
    order: 3,
    id: 'nbdpsy_pitch',
    name: '推介闸',
    effect: 'rewrite',
    notice: 'NBDPSY_PITCH_BLOCKED',
    status: 'live',
    stage: 'post',
    anchor: 'stripNbdpsyPitch(',
    guards: '模型段自行推销付费咨询：推荐只走产品的推荐段（须占位并落台账）',
  },
  {
    order: 4,
    id: 'precedent_contamination',
    name: '判例污染',
    effect: 'observe',
    notice: 'PRECEDENT_CONTAMINATED',
    status: 'live',
    stage: 'post',
    anchor: 'precedentContamination(',
    guards: '真案号配假案情：只留痕不改正文（剥掉会把整段判例分析弄得莫名其妙）',
  },
  {
    order: 5,
    id: 'citation_guard',
    name: '案号闸',
    effect: 'rewrite',
    notice: 'CITATION_BLOCKED',
    status: 'live',
    stage: 'stream',
    anchor: 'citations.push(',
    guards: '编造案号：流上缓冲到闭合再判，验不过原地换【案号待核实】',
  },
  {
    order: 6,
    id: 'statute_guard',
    name: '条号闸',
    effect: 'rewrite',
    notice: 'STATUTE_UNVERIFIED',
    status: 'live',
    stage: 'stream',
    anchor: 'statutes.push(',
    guards: '编造/错配条号（把 §46 讲成 §47）、引用已修正/已废止的源',
  },
  {
    order: 7,
    id: 'strip_unsupported_quotes',
    name: '伪逐字引用闸',
    effect: 'rewrite',
    notice: 'CITATION_BLOCKED',
    status: 'live',
    stage: 'post',
    anchor: 'stripUnsupportedQuotes(',
    guards: '引号内条文本轮查无此文：整句改口，剥除语义不改',
  },
  {
    order: 8,
    id: 'core_article_fallback',
    name: '核心位保底渲染',
    effect: 'rewrite',
    notice: 'CORE_ARTICLE_RENDERED',
    status: 'live',
    stage: 'post',
    anchor: 'renderCoreArticleFallback(',
    guards: '核心位光秃：就地补上卡内逐字原文（消灭这个类别本身）',
  },
  {
    order: 9,
    id: 'value_guard',
    name: '数值闸',
    effect: 'rewrite',
    notice: 'VALUE_UNSOURCED',
    status: 'live',
    stage: 'post',
    anchor: 'applyValueGuard(',
    guards: '编造数字（「封顶 60 万」「按 3N」）：不在 claim_calc 出参与 facts.values 的标记出来',
  },
  {
    order: 10,
    id: 'practice_boundary',
    name: '承诺/边界字面表',
    effect: 'rewrite',
    notice: 'PRACTICE_BOUNDARY_BLOCKED',
    status: 'planned',
    stage: 'post',
    anchor: null,
    guards:
      '越界执业与结果承诺的运行时字面闸（设计稿 §5 第 9 项）。**本片未实现**：' +
      '顺序先钉住，免得日后接线的人把它插在 ⑨ 之前——那样它会去判 ⑨ 刚插进正文的标记文本。',
  },
];

/** 按 id 取一道闸（找不到即抛：id 是受控枚举，取不到说明表和消费方已经分叉） */
export function gateOf(id: GateId): GateSpec {
  const hit = GATE_CHAIN.find((g) => g.id === id);
  if (!hit) throw new Error(`闸链里没有 id=${id}——GATE_CHAIN 与消费方已分叉`);
  return hit;
}

/** 已接线的闸，按链序 */
export function liveGates(): GateSpec[] {
  return GATE_CHAIN.filter((g) => g.status === 'live');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * gate_report：十道闸的统一汇总口
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么要汇总口】每道闸各发各的 notice 是对的（code 混用两边统计一起失真），
 * 但「这一轮闸链一共动了正文几处」在此之前**没有任何一处能回答**：
 * 要读五条 notice、各自解析 message 里的中文数字，而 message 是给人看的、随时会改文案。
 *
 * 所以：notice 归 notice（各闸各写、给人看），gate_report 归 gate_report（结构化、给机器读）。
 * 判据只读这一份，**不从 message 反推**——反推等于给统计开第二个真源。
 */

/** 一道闸这一轮的工作量。`seen` 是分母，`fired` 是分子，两个都要有才算得出率。 */
export interface GateTally {
  /** 这道闸这一轮**看过**多少个候选（条号引用数 / 数值 token 数 / 引号块数…） */
  seen: number;
  /** 其中**动了手**的有几处（替换、标记、剥除、补入） */
  fired: number;
}

/**
 * 进**替换率**分子分母的闸。
 *
 * 【为什么不是全部十道】①②③④ 也在跑，但它们没有"候选数"这个分母：
 * 「危机轮开没开火」是一个 0/1 事件，与「本轮 12 处引用里换了 1 处」不可通约。
 * 把它们塞进同一个率里，率的分母就变成了一堆不同量纲的数之和——
 * 那个数会随剧本类型上下跳，而没人能说出它跳的是什么。
 * 它们的开火次数由各自的 notice 承载（这正是"每道闸只写自己的 notice 通道"）。
 *
 * ⑧ 也不进：它是**补入**不是替换。把"补了 1 条原文"记进替换率的分子，
 * 等于把我们做对的一件事记成闸误伤——而超预算的处置是去查闸的判据，
 * 于是每补一条原文都会引来一次对闸的复查。
 */
export const RATE_GATES: readonly GateId[] = ['citation_guard', 'statute_guard', 'strip_unsupported_quotes', 'value_guard'];

export interface GateReport {
  /**
   * 按闸 id 分账。**只登记给得出「候选数 + 动手数」两个数的闸**（⑤⑥⑦⑧⑨）——
   * ①②③④ 不在此列，理由见 `RATE_GATES`。这不是"它们没跑"，
   * 是"它们的工作量不能用这两个数表达"，两者不许在报表里长成同一个样子。
   */
  gates: Partial<Record<GateId, GateTally>>;
  /**
   * **漏网数**：闸跑完之后，用户面仍然存在的、不在放行集里且没有标记的引用。
   * 结构上应恒为 0；不为 0 就是闸本身漏了（不是模型变差），必须当缺陷查。
   */
  leaked: number;
  /**
   * 登记簿 `source_status` 未接上的条数（设计稿 §7.3 待接项）。
   * 单列而不是并进 `fired`：**"我们不知道这条源是不是现行"** 与 "它是现行" 是两件事，
   * 合并的形态是接上登记簿的那天报表一个字都不变。
   */
  sourceStatusUnknown: number;
  /**
   * ⑥ 形态上分不清「条号」与「第三条建议」那种序数量词、**明说不判**而放过去的处数。
   *
   * 【为什么它必须有一个数，而不是只写在注释里】这是一个**故意留的洞**：
   * 裸的第一条…第十条闸不碰。洞留着可以，但"洞有多大"必须每轮看得见——
   * 只写在注释里的缺口与"这个缺口不存在"在报表上长得一模一样。
   */
  ambiguousBareArticles: number;
  /**
   * ⑥ 在**文书通道**拒收的处数。**不进替换率**：文书是拒收不是替换，
   * 那一处从来没有出现在用户面前，把它算进"闸动了正文几处"就是把两件事混成一件
   *（实测：一份文书引错 1 处 + 正文 1 处引用 → 替换率报 50% → 成绩单点名"闸误伤"）。
   */
  docRejected: number;
}

export function newGateReport(): GateReport {
  return { gates: {}, leaked: 0, sourceStatusUnknown: 0, ambiguousBareArticles: 0, docRejected: 0 };
}

/** 记一道闸的工作量。同一道闸多次记账**累加**（文书通道与正文通道各记各的）。 */
export function tallyGate(report: GateReport, id: GateId, tally: GateTally): void {
  const cur = report.gates[id] ?? { seen: 0, fired: 0 };
  report.gates[id] = { seen: cur.seen + tally.seen, fired: cur.fired + tally.fired };
}

/**
 * 替换率预算（设计稿 §4.3 初值）。**超预算 = 闸误伤，不是模型变差**——
 * 这句定性写在常量旁边，因为它决定超标之后去查哪一边：查闸的判据，不是去调提示词。
 */
export const REPLACE_RATE_BUDGET = 0.02;

export interface GateReportSummary {
  /** 全链候选总数（各闸 seen 之和） */
  seen: number;
  /** 全链动手总数（各闸 fired 之和） */
  fired: number;
  /** 替换率 = fired / seen。seen 为 0 时是 0（本轮没有候选，不是 0% 也不是 100%） */
  replaceRate: number;
  /** 漏网数（从 GateReport 原样带过来，免得读汇总的人还要再回去翻一次原始报表） */
  leaked: number;
  /** 漏网率 = leaked / seen。同上 */
  leakRate: number;
  /** 替换率超预算。**不阻断**，只在报告里点名（判据侧同口径） */
  overBudget: boolean;
}

/**
 * 汇总。**替换率与漏网率并列**——只报一个的形态是：
 * 闸把什么都替换掉，替换率高得离谱而漏网率恒 0，看起来"守得很严"；
 * 或者闸一处都不替换，替换率 0 而漏网全靠没人看。两个率必须一起读才有意义。
 */
export function summarizeGateReport(report: GateReport): GateReportSummary {
  let seen = 0;
  let fired = 0;
  for (const id of RATE_GATES) {
    const t = report.gates[id];
    if (!t) continue;
    seen += t.seen;
    fired += t.fired;
  }
  const replaceRate = seen === 0 ? 0 : fired / seen;
  return {
    seen,
    fired,
    replaceRate,
    leaked: report.leaked,
    leakRate: seen === 0 ? 0 : report.leaked / seen,
    overBudget: replaceRate > REPLACE_RATE_BUDGET,
  };
}
