// app/src/lib/agent/retrieval.ts
// knowledge packs 检索的**最小消费侧接口**。
//
// 【边界声明】pack 的加载与索引实现归 lib/knowledge（WS4，尚未交付）。本文件只定义
// 「agent 需要 knowledge 长什么样」，不含任何文件读取、分词或排序逻辑。WS4 交付后
// 由它实现 KnowledgeSearcher 并在路由层注入，lib/agent 一行不用改。
// 字段取自 knowledge/README.md §2 frontmatter 与 §6 index.json 的定义，逐个对齐。

/** 一张检索命中的知识卡。body 是**逐字原文**——这是整个接口的要害。 */
export interface KnowledgePack {
  /** `<域单数>-<slug>`，全库唯一（README §1） */
  id: string;
  /** 法条卡|判例卡|计算规则|流程SOP|文书模板|话术卡|情绪指南|数据卡 */
  type: string;
  title: string;
  keywords: string[];
  applies_to: string[];
  /** 北京|全国 */
  region: string;
  /** 原文核实|二手转述|待核实。charter §3：标「待核实」的引用时必须如实带上这个状态 */
  confidence: string;
  updated: string;
  /**
   * pack 正文（frontmatter 之后的全部内容），**一字不改**。
   *
   * 为什么要全文而不是摘要：charter §3 要求法条给「条号 + 逐字原文」。摘要过一道
   * 就等于让模型转述法条，而转述过的法条与编造的法条在用户眼里没有区别——
   * 可信度是这个产品的生命线，宁可多烧 token 也不能在这里做压缩。
   */
  body: string;

  /**
   * **结构化事实**（manager 2026-08-20 根治方向）：凡「事实被代码消费」的卡，
   * 事实应进 frontmatter 结构化字段，代码只读这里，**禁止用正则啃正文散文**。
   *
   * 三个读法（WS4 规范）：`values` 按 key 取数、`hotlines` 按 status 过滤、
   * `statute_quotes` 取逐字条文。形状与 lib/knowledge 的 PackFacts 一致。
   */
  facts?: {
    hotlines?: Array<{ name: string; phone: string; status: 'usable' | 'forbidden'; hours?: string; note?: string }>;
    values?: Array<{ key: string; value: number; unit: string; effective_from: string; confidence: string }>;
    statute_quotes?: Array<{ law: string; article: string; text: string }>;
    /**
     * 判例卡的结构化案情。判例段一律由这些字段拼装，**不许模型自由复述**——
     * 自由复述会把对话里的用户事实织进判例案情（ISSUE-03：案号是真的、细节是编的，
     * 恰好绕过只验号码存在性的案号闸），用户当庭复述后对方一查全文没有该情节，
     * 失信的是用户本人。
     */
    case_facts?: { case_no?: string; court?: string; judged_at?: string; gist?: string; issue?: string; holding?: string; reasoning?: string };
    /** ⭐核心条的 S3 档：场景 → 核心依据条映射（见 method-core-article-map 卡） */
    core_article_map?: Array<{ scene: string; claim_kind?: string; articles: string[] }>;
  };
}

export interface KnowledgeSearchResult {
  packs: KnowledgePack[];
  /** 实际用于检索的查询串，回显给前端做「依据从哪来的」展示 */
  query: string;
}

/** WS4（lib/knowledge）需要实现的全部东西。 */
export interface KnowledgeSearcher {
  /**
   * 按自然语言查询取 pack。README §6 定的检索逻辑是 keywords + applies_to + title 分词匹配。
   * 检索不到返回空数组（不是抛错）——「没有依据」是一种正常且必须被上层看见的结果。
   */
  search(query: string, options?: { limit?: number; type?: string }): KnowledgePack[];
  /** 按 id 精确取卡（模型引用了某张卡的 related 时用） */
  get?(id: string): KnowledgePack | undefined;
  /**
   * 按 `法名|条号` 复合键找**收录了该条逐字原文**的卡（S3b 定向注入用）。
   *
   * 【为什么不用 search】这是**按事实精确取料**，不是按词面相关性取料——
   * 映射表已经声明了"本场景核心条是哪几条"，剩下的是把那几条的原文取回来，
   * 让检索打分插一脚只会引入不确定性（且 manager 明令本轮不动检索打分）。
   */
  findByArticleKeys?(keys: string[]): KnowledgePack[];
}

/** 单次回复最多注入多少张卡的全文。超过这个数 system prompt 会挤掉案件档案本身。 */
export const MAX_INJECTED_PACKS = 6;

/**
 * charter §3 的「检索不到依据」路径，写成常量而不是让模型自由发挥。
 *
 * 这段话会在**本轮一张卡都没检索到**时作为 system 提示注入。它不是礼貌用语，
 * 是硬约束：此时模型手上没有任何可引用的条号与数字，一旦它凭记忆写出
 * 「劳动合同法第 X 条规定……」或「北京社平工资是 XXXXX」，那就是 C04 的 G1 红线事故。
 */
export const KNOWLEDGE_MISS_DIRECTIVE = [
  '【本轮检索结果：无命中】知识库这轮没有返回任何依据卡。',
  '据此你**没有**任何可引用的条号、案号、文号或数字，因此本轮：',
  '1. 涉法结论一律按 charter §3 处理——明说「这点我需要核实，先按保守做法……」，再给保守做法；',
  '2. 禁止写出任何具体条号、案号、文号、金额标准、社平/最低工资数值，凭记忆写出来的一律视为编造；',
  '3. 行动建议照常给（动作本身不依赖法条），把「等我核实依据」也写成其中一张卡的内容。',
].join('\n');
