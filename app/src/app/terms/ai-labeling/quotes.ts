// app/src/app/terms/ai-labeling/quotes.ts
// 标识说明页里**逐字引用的法条**，连同它出自哪一份登记在册的官方原件。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。这里只有法条原文与条号。
// ─────────────────────────────────────────────────────
//
// 【为什么把引文抽成数据，而不是直接写在 JSX 里】写在 JSX 里的引文没有任何一处能机械核对：
// 改错一个字、把两款并成一款、把"文本的生成"记成"文本生成"，页面照常渲染、
// 读起来仍然像一句法条。抽成这份表之后，
// app/__tests__/ai-labeling-quotes.test.ts 逐条拿去和 knowledge/sources/originals/
// 下那两份原件比对——对不上当场红。
//
// 【改这里的规矩】只能从 `knowledge/sources/originals/<source_id>/text.txt` 里
// **复制**出来，不许照记忆敲。原件本身只由 scripts/fetch-source.py 落盘。

/** 《人工智能生成合成内容标识办法》（国信办通字〔2025〕2号，2025-09-01 施行） */
export const SRC_BIAOSHI_BANFA = 'statute-ai-shengcheng-hecheng-neirong-biaoshi-banfa';
/** 《互联网信息服务深度合成管理规定》（三部门令第12号，2023-01-10 施行） */
export const SRC_SHENDU_HECHENG = 'statute-shendu-hecheng-guanli-guiding';

export interface LawQuote {
  /** 登记簿里的 source_id（knowledge/sources.json） */
  readonly source: string;
  /** 条款位置，给人看的，如「第四条第一款」 */
  readonly at: string;
  /** 逐字原文。**一个字都不许改**——判据按归一后的子串关系核 */
  readonly text: string;
}

/**
 * 页面上出现的每一段引文。键名只在代码里用，不上屏。
 *
 * 【适用链条为什么要引三段】"这一页凭什么管我们"这件事，法条上要走两跳：
 * 标识办法 §4 只说"属于深度合成规定 §17 第一款情形的"要加显式标识，
 * 到底哪一种服务属于那一款，写在**另一份**规章里。只引 §4 的形态是：
 * 读的人无从判断我们是不是那一款，而我们自己也就无从被质疑。
 */
export const LAW_QUOTES = {
  /** 显式标识的适用条件（链条第一跳） */
  banfa4Head: {
    source: SRC_BIAOSHI_BANFA,
    at: '第四条第一款',
    text: '服务提供者提供的生成合成服务属于《互联网信息服务深度合成管理规定》第十七条第一款情形的，应当按照下列要求对生成合成内容添加显式标识：',
  },
  /** 文本类怎么加（链条落到具体做法） */
  banfa4Item1: {
    source: SRC_BIAOSHI_BANFA,
    at: '第四条第一款第（一）项',
    text: '在文本的起始、末尾或者中间适当位置添加文字提示或者通用符号提示等标识，或者在交互场景界面、文字周边添加显著的提示标识',
  },
  /** 下载 / 复制 / 导出的那一款 */
  banfa4Tail: {
    source: SRC_BIAOSHI_BANFA,
    at: '第四条第二款',
    text: '服务提供者提供生成合成内容下载、复制、导出等功能时，应当确保文件中含有满足要求的显式标识。',
  },
  /** 隐式标识的三要素 */
  banfa5: {
    source: SRC_BIAOSHI_BANFA,
    at: '第五条第一款',
    text: '在生成合成内容的文件元数据中添加隐式标识，隐式标识包含生成合成内容属性信息、服务提供者名称或者编码、内容编号等制作要素信息',
  },
  /** 这一页存在的理由 */
  banfa8: {
    source: SRC_BIAOSHI_BANFA,
    at: '第八条',
    text: '服务提供者应当在用户服务协议中明确说明生成合成内容标识的方法、样式等规范内容，并提示用户仔细阅读并理解相关的标识管理要求。',
  },
  /** 不含显式标识的那条路（本平台没开） */
  banfa9: {
    source: SRC_BIAOSHI_BANFA,
    at: '第九条',
    text: '服务提供者可以在通过用户协议明确用户的标识义务和使用责任后，提供不含显式标识的生成合成内容，并依法留存提供对象信息等相关日志不少于六个月。',
  },
  /** 用户自己的标识义务 */
  banfa10Duty: {
    source: SRC_BIAOSHI_BANFA,
    at: '第十条第一款',
    text: '用户使用网络信息内容传播服务发布生成合成内容的，应当主动声明并使用服务提供者提供的标识功能进行标识。',
  },
  /** 禁止行为 */
  banfa10Ban: {
    source: SRC_BIAOSHI_BANFA,
    at: '第十条第二款',
    text: '任何组织和个人不得恶意删除、篡改、伪造、隐匿本办法规定的生成合成内容标识，不得为他人实施上述恶意行为提供工具或者服务，不得通过不正当标识手段损害他人合法权益。',
  },
  /** 链条第二跳：哪些服务落在 §17 第一款里 */
  shendu17Head: {
    source: SRC_SHENDU_HECHENG,
    at: '第十七条第一款',
    text: '深度合成服务提供者提供以下深度合成服务，可能导致公众混淆或者误认的，应当在生成或者编辑的信息内容的合理位置、区域进行显著标识，向公众提示深度合成情况：',
  },
  /** 本平台落在这一项上：智能对话与智能写作 */
  shendu17Item1: {
    source: SRC_SHENDU_HECHENG,
    at: '第十七条第一款第（一）项',
    text: '（一）智能对话、智能写作等模拟自然人进行文本的生成或者编辑服务；',
  },
  /** 隐式标识那一跳（标识办法 §5 指向的就是它） */
  shendu16: {
    source: SRC_SHENDU_HECHENG,
    at: '第十六条',
    text: '深度合成服务提供者对使用其服务生成或者编辑的信息内容，应当采取技术措施添加不影响用户使用的标识，并依照法律、行政法规和国家有关规定保存日志信息。',
  },
} as const satisfies Record<string, LawQuote>;
