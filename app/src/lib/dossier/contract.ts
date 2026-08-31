// app/src/lib/dossier/contract.ts
// 公司档案的**呈现契约**：GET /api/v1/company/dossiers/{id} 的响应形状。
// 文字版见 docs/contracts/dossier-api.md。
//
// 【这份契约是谁的】呈现侧（工单 C）定的形状，统计侧（A 的 lib/company/stats.ts）
// 与计费侧（B 的三个 API）按它填。放在 lib/ 而不是页面目录下，就是为了让 A/B
// 能 import 同一份类型——三张工单并行开发靠契约咬合，不靠等。
//
// 【一条贯穿全文件的纪律】凡是"算出来的数字"，都必须带着它的样本量、截止日和来源
// 一起过来。这不是为了好看：一个没有样本量的百分数在法律场景里比没有数字更坏，
// 它让用户以为自己知道了什么。所以下面每张卡的三件套都是**非可选字段**，
// 缺就填 null，由 StatCardGuard 拦在渲染之前（见 §渲染守卫）。

/* ── 分块进度 ─────────────────────────────────────────── */

export type BlockKey = 'graph' | 'litigation' | 'stats' | 'patterns';

/**
 * 块状态。三态语义照 job_runs（migrate.ts 741-779）：
 * `queued` = 无行/没排过；`running` = 有行但 finished_at 为空（在跑或崩了）；
 * 其余三个 = 有结论。`expired` 单独一档，因为它带着退款，不是普通失败。
 */
export type BlockState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'expired';

export interface DossierBlock {
  block: BlockKey;
  state: BlockState;
  startedAt: string | null;
  finishedAt: string | null;
  /** 失败原因照三段式（缺什么/为什么缺/怎么办）由后端写好，前端不改写、不省略 */
  errorText: string | null;
}

/* ── 统计：口径见设计 §1.2 ─────────────────────────────── */

/**
 * 每张统计卡都必须带的三件套。缺任一项 ⇒ 不渲染数字。
 * 分成独立接口而不是散在各卡上，是为了让渲染守卫只认一种形状。
 */
export interface StatProvenance {
  /** 这张卡的样本量。注意是**这张卡的**，不是全档案的 */
  sampleN: number | null;
  /** 采集截止日 = MAX(fetched_at)，即"数据只到这一天" */
  asOf: string | null;
  /** 如「裁判文书网·人机接力取证」 */
  source: string | null;
}

/**
 * 结果比例卡。
 *
 * 【指标名不叫"胜诉率"】叫「劳动者全部或部分获支持的比例」。理由（设计 §1.1）：
 * 分母是幸存者（上网率持续下降）、方向会反（存在用人单位起诉员工的批量案，
 * "公司赢了"和"劳动者输了"不是同一件事）、分子多数取不到（大量条目只有案号没有全文）。
 * 所以比率只准以 `docsOutcomeDecided` 为分母，且必须与申请人方分布同屏并列。
 */
export interface OutcomeStats extends StatProvenance {
  /** 该主体全部入档行数（含仅列表项） */
  docsTotal: number;
  /** 取到全文的篇数 */
  docsFulltext: number;
  /** 可判定结果的篇数——比率的**唯一合法分母** */
  docsOutcomeDecided: number;
  /** 劳动者全部或部分获支持的件数 */
  workerFavorableN: number;
  /**
   * 出比例的最低样本量，来自 pricing_config 的 dossier.min_sample_outcome。
   * **前端不许硬编码这个数**：门槛写死在界面上，改表就改不动它，
   * 而"门槛是多少"恰恰是这块诚实性的全部内容。
   */
  minSample: number;
  /** 申请人方分布，与比例同屏并列（不区分程序位置的比率是错的数） */
  byApplicant: { worker: number; employer: number; unknown: number };
}

export type DurationSegmentKey = 'arbitration' | 'firstInstance' | 'secondInstance' | 'execution';

/**
 * 时长四段之一。**各段独立样本量、独立门槛**，一段不足不牵连全表。
 * 注意这里没有、也不许有"平均时长"那样的合成字段——把四段合成一个数，
 * 等于告诉用户"你的案子大概要这么久"，而四段的分布形状完全不同。
 */
export interface DurationSegment extends StatProvenance {
  key: DurationSegmentKey;
  /** 只用文书上**载明的日期**算，推断的一律不计 */
  n: number;
  medianDays: number | null;
}

export interface DurationStats {
  /** 来自 pricing_config 的 dossier.min_sample_duration，同样不许前端写死 */
  minSample: number;
  segments: DurationSegment[];
}

/* ── 套路归纳：零编造约束见设计 §1.3 ───────────────────── */

export interface PatternEvidence {
  caseNo: string;
  /** 全文的**逐字**子串。落库前已由代码校验过，前端只负责原样显示 */
  quote: string;
  docUrl: string | null;
}

export interface DossierPattern {
  id: string;
  pattern: string;
  /** 空数组的 pattern 在后端就该被丢掉；前端再拦一道（双保险） */
  evidence: PatternEvidence[];
  model: string;
  generatedAt: string;
}

/* ── 仲裁地风格卡：只引存档，LLM 不生成 ─────────────────── */

export interface VenueCard {
  /** knowledge pack id，如 sop-chaoyang-lian-sop */
  id: string;
  title: string;
  /** 卡的正文原文（剥掉 frontmatter），不改写 */
  body: string;
  sources: string[];
  confidence: string;
  updated: string;
}

/**
 * 首发只做北京朝阳。其它仲裁地 `covered: false` 且 `cards` 为空——
 * **不用通用话术填坑**：一段"各地仲裁大同小异"的话读起来像内容，
 * 实际是我们没核实过的辖区在冒充核实过的辖区。
 */
export interface VenueSection {
  venue: string;
  covered: boolean;
  cards: VenueCard[];
}

/* ── 档案根 ───────────────────────────────────────────── */

export interface DossierRefund {
  refunded: boolean;
  /** 如「样本不足」「超期未交付」，中性文案由通知层另发 */
  reason: string | null;
  amountGongdao: number | null;
}

export interface DossierView {
  id: string;
  /** 公司名。**只准出现在正文的 Sensitive 里**，不进页面标题/tab title（低调模式红线） */
  companyName: string;
  blocks: DossierBlock[];
  /** 队列位置；null = 不在排队 */
  queuePosition: number | null;
  outcome: OutcomeStats | null;
  duration: DurationStats | null;
  patterns: DossierPattern[];
  /** 被逐条校验丢掉的 pattern 条数——编造率的体温计，必须可见 */
  droppedPatterns: number;
  venue: VenueSection;
  /**
   * 覆盖度声明。**结构化必渲染字段，不是可折叠脚注**：外勤已经把这句话写出来了，
   * 把它降级成小字等于让用户替我们承担诚实税。
   */
  coverageNote: string;
  /**
   * 在职年限。**不参与公司档案的任何统计**，只用于判例呈现排序。
   * 页面上必须写明这一句，否则用户会以为它影响了公司数据。
   */
  tenureYears: number | null;
  refund: DossierRefund | null;
  /** 谱系块是否已交付（决定图谱入口给不给点） */
  graphReady: boolean;
}

/* ── 报价：B 的 quote 接口响应 ─────────────────────────── */

export interface QuoteLine {
  /** 与 lib/billing/features 的 feature 键对齐 */
  feature: 'dossier_graph' | 'dossier_litigation';
  label: string;
  gongdao: number;
  /** 这一块交付什么、什么时候到、可能拿不到什么 */
  delivers: string;
  /** null = 无时延承诺（同步出）；否则是工作日上限 */
  slaWorkdays: number | null;
  /** 拿不到货时退不退、退多少 */
  refundPromise: string | null;
  /** 可否单买 */
  optional: boolean;
}

export interface DossierQuote {
  lines: QuoteLine[];
  totalGongdao: number;
  /** 缓存命中：如实告知第二个用户"本公司已有 X 天前的存档" */
  cache: { hit: boolean; ageDays: number | null; cachedGongdao: number | null };
  /** 有未核销的会员赠送次数时，确认页显示"本次不扣公道值" */
  entitlementAvailable: boolean;
  balanceGongdao: number;
}
