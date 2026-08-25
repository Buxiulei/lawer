// app/src/lib/agent/citation-block.ts
// 把卡里**可引用的内容**预格式化成「照抄即合规」的引用块。
//
// 【为什么是这个形状——manager 2026-08-21 定的产品价值论据，逐字记住】
//
// > 我们的用户是请不起律师、必须自己上庭的人——拿着光秃秃的「劳动合同法第47条」
// > 既无法自查也无法当庭引用，等于空手；给了逐字原文他才能打印、标出、念出来。
// > **这不是回复密度问题，是产品价值是否成立。**
//
// 【为什么用"预格式化"而不是"下更严的指令"——提示词工程原则（manager 2026-08-21 升格记档）】
// G4 依据纪律在 S15 定版批 6/6 全挂，而提示词里"必须给逐字原文"这句话一直都在。
// 再写一遍更严的指令，第 7 次也还是会挂。真正起作用的是**改变成本**：
// 把条号+逐字原文+生效期间+来源卡拼好放在模型眼前，让**照抄比自己缩写更省力**。
// 模型走的永远是最省力那条路——与其禁止它走近路，不如把合规那条修成近路。
//
// 这条与「指令贴约束对象」是一对：一个管**位置**（指令要挨着它约束的东西），
// 一个管**成本**（正确行为要比错误行为便宜）。两次修好「别重印整卡」和「卡值三件套」
// 用的都是这两条。
//
// 【边界】本模块只读 facts，**绝不解析正文散文**——那是热线号码事故的根因（见 crisis.ts）。
// 卡里没有结构化字段时不猜、不抠，改为下发「填空模板」告诉模型输出成什么形状，
// 原文它手上本来就有（packsSection 下发的是全文）。

import type { KnowledgePack } from './retrieval';

/** 引用块的统一抬头。措辞写死，不交给模型即兴——它要照抄的东西必须每轮长得一样。 */
const HEADER = '【可直接照抄的引用块】';

/**
 * 法条引用块：条号 + 逐字原文 + 来源卡。
 * 只从 `facts.statute_quotes` 取；卡没有这个字段就返回空数组（交给填空模板那条路）。
 */
export function statuteBlocks(pack: KnowledgePack): string[] {
  return (pack.facts?.statute_quotes ?? [])
    .filter((q) => q?.law && q?.article && q?.text)
    .map((q) => [`${HEADER}`, `《${q.law.replace(/^《|》$/g, '')}》${q.article}：`, `> ${q.text}`, `（来源卡：${pack.id}）`].join('\n'));
}

/**
 * 数字引用块：值 + 单位 + 生效期间 + 可信度 + 来源卡。
 *
 * 【生效期间与可信度不是装饰】同一个「社平工资」逐年不同，用户拿一个没有年份的数字上庭，
 * 对方一句「你说的是哪一年的」就问住了。可信度标「待核实」的还必须带着这个状态说
 * （charter §3）——不带状态地引用一个待核实值，等于把它说成已核实。
 */
export function valueBlocks(pack: KnowledgePack): string[] {
  return (pack.facts?.values ?? [])
    .filter((v) => v?.key && typeof v.value === 'number')
    .map((v) => {
      const status = v.confidence && v.confidence !== '原文核实' ? `｜可信度「${v.confidence}」，引用时必须一并告诉用户` : '';
      return [
        `${HEADER}`,
        `${v.key}：**${v.value} ${v.unit}**（生效期间 ${v.effective_from} 起${status}｜来源卡：${pack.id}）`,
      ].join('\n');
    });
}

/**
 * 判例引用块：案号/出处 + 审级 + 案情要旨 + 争议焦点 + 结果 + 裁判理由，**全部取自卡字段**。
 *
 * 【为什么判例必须模板化拼装而不是让模型自由复述——ISSUE-03】
 * S04 实测：模型引用了真卡 `case-yunqi-tiaogang-baoding-2024`（邓某诉某置业公司），
 * 案由、结果、审级都与卡一致，**却把用户自己的事实**「次日报到」「未明确新岗位及薪资待遇」
 * **写进了判例案情**——卡里没有这两节。
 *
 * 这比光秃条号隐蔽得多，也危险得多：
 * - 案号是**真的**，所以只验「号码在不在库里」的案号闸**完全拦不住**；
 * - 不逐字比对卡，人也看不出来——它读起来比真的还贴合；
 * - 用户当庭复述这个"和我一模一样"的案例，对方一查全文没有该情节，**当庭失信的是用户**。
 *
 * 所以本卡的判例段给成**拼好的块**：模型要讲相似点，就另起一句「你的情况与之相似之处是…」，
 * 把「判例事实」与「你的事实」在结构上分开（与三栏分离纪律同源）。
 */
export function precedentBlocks(pack: KnowledgePack): string[] {
  const c = pack.facts?.case_facts;
  if (!c || !(c.gist || c.holding)) return [];
  const line = (label: string, v?: string) => (v && v.trim() ? [`${label}：${v.trim()}`] : []);
  return [
    [
      HEADER,
      `《${pack.title}》`,
      ...line('案号/出处', c.case_no),
      ...line('审级', c.court),
      ...line('案情要旨', c.gist),
      ...line('争议焦点', c.issue),
      ...line('结果', c.holding),
      ...line('裁判理由', c.reasoning),
      `（来源卡：${pack.id}）`,
      '',
      '⚠️ **判例段只能复述以上字段**。用户自己的情况（时间、岗位、薪资、公司做法……）',
      '一个字都不许写进判例案情——案号是真的、细节是编的，比整条编造更危险，',
      '因为它骗得过案号核验、也骗得过读的人。要讲相似点就**另起一句**：',
      '「你的情况与之相似之处是……」，把判例事实与你的事实分开摆。',
    ].join('\n'),
  ];
}

/**
 * 卡里**没有**结构化可引用字段时下发的填空模板。
 *
 * 【为什么不去正文里抠】库里 8 张法条卡只有 1 张带 `statute_quotes`，103 张判例卡一张都没有；
 * 逐字原文确实在卡的正文散文里。用正则从散文里抠出来当"逐字原文"发给用户，
 * 比现在光给条号**更危险**——抠错一句，用户会当庭把它念出来。
 * 所以这里给的是**形状**不是内容：原文就在它上面的卡全文里，让它照着形状抄。
 */
export function citationTemplate(pack: KnowledgePack): string {
  const shape =
    pack.type === '判例卡'
      ? '案号/案例编号 + 来源（哪一批典型案例）+ 卡里写明的裁判要旨与结果'
      : '条号 + 「逐字原文」（引号内一字不改，从上面这张卡的正文里抄）';
  return [
    `【引用本卡的必备形状】${shape} + （来源卡：${pack.id}）。`,
    '只给条号/案号而不给逐字内容的引用**视为未完成**——用户要拿它去打印、标出、当庭念出来，',
    '光秃秃一个编号对他等于空手。原文就在上面这张卡里，照抄，不要改写、不要缩写。',
  ].join('\n');
}

/**
 * 一张卡的完整引用指引：有结构化字段就给拼好的引用块，没有就给填空模板。
 *
 * 返回的字符串**紧贴该卡正文之后**下发（见 prompt.packsSection / tools.knowledge_search）——
 * 指令要挨着它约束的那张卡，放通用指令区会被稀释（实测：「别重印整卡」写在开头被无视两轮）。
 */
/**
 * 一张卡的**全部可引用文本**：`title\nbody\nJSON(facts)`。
 *
 * 【为什么要单独导出】"卡里有没有这段话"这个问题在多处被问到——第五闸比对注入语料、
 * 判例污染比对卡内容、库内判定。各处各拼一遍字符串，就会出现**同一个问题在不同地方
 * 用不同语料回答**（本轮 bug 的同族形态）。抽成一处，语料口径天然一致。
 *
 * 【为什么含 facts 的 JSON】结构化字段里的逐字原文（statute_quotes.text）也是卡的正文，
 * 只看 body 会漏掉它；反过来只看 facts 会漏掉写在正文 blockquote 里的原文。**两者都要。**
 */
export function packCorpus(pack: Pick<KnowledgePack, 'title' | 'body' | 'facts'>): string {
  return `${pack.title}\n${pack.body}\n${JSON.stringify(pack.facts ?? {})}`;
}

/** 汉字数字 → 整数（覆盖 1–999：四十六=46、十九=19、二十=20、一百零八=108）。非法返回 null。 */
function cnNumeral(s: string): number | null {
  if (/^[0-9]+$/.test(s)) return Number(s);
  const D: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in D) {
      section = D[ch];
      seen = true;
    } else if (ch === '十') {
      total += (section || 1) * 10;
      section = 0;
      seen = true;
    } else if (ch === '百') {
      total += (section || 1) * 100;
      section = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + section : null;
}

/**
 * 条号归一：统一成 `第<阿拉伯数字><条|问>`，**跨数字体系互认并剥掉「第N项/第N款」**。
 *
 * **这是条号归一的唯一真源**——产线与评测侧共用本函数（评测侧 import，不另写一份）。
 * 本 bug 的成因正是"两处各写一份"：判据侧改了、行为侧没跟上，静默漂移。
 *
 * 【为什么必须跨数字体系】卡里一律存汉字（`第四十六条`），而模型惯写阿拉伯
 * （实测原话「《劳动合同法》第46条第2项」）。不互认 → 键对不上 →
 * 库里**明明有** 280 字原文的核心条文被判成「等卡」，**真挂被洗成 N/A**。
 * 这个方向是漏判：成绩单显示「0 光秃」，读起来像修法生效——我据此报过一次错误结论。
 *
 * 【为什么必须剥项/款】卡按「条」存原文，引用常带到项/款
 * （`bareArticleCitations` 的正则也会把「第2项」一起捕获）。不剥 → 同样对不上键。
 *
 * 【为什么保留单位】`第55问`（534 号解答）与 `第55条` 不是一回事，单位不能丢。
 *
 * 【为什么「之N」独立成键】`第四十七条之一` 与 `第四十七条` 是**两条不同的条文**（中文立法通例）。
 * 合并它们的错误方向与「短法名吞长法名」同族：不互认看得见（键对不上），
 * 张冠李戴看不见（拿甲条的原文去要求乙条）。
 */
export function normalizeArticle(a: string): string {
  const flat = a.replace(/[《》\s]/g, '');
  const m = /第([0-9]+|[一二三四五六七八九十百零〇两]+)(条|问)(之([0-9]+|[一二三四五六七八九十]+))?/.exec(flat);
  if (!m) return flat;
  const n = cnNumeral(m[1]);
  const head = n === null ? `第${m[1]}${m[2]}` : `第${n}${m[2]}`;
  if (!m[4]) return head;
  const sub = cnNumeral(m[4]);
  return `${head}之${sub === null ? m[4] : sub}`;
}

/** 法名归一：全称↔简称互认。**不做包含匹配**——短名吞长名的错误看不见，比键对不上危险。 */
export function normLaw(law: string | null | undefined): string {
  if (!law) return '';
  return law.replace(/[《》\s]/g, '').replace(/^中华人民共和国/, '');
}

/** 引用键：`法名|条号`。卡侧与引用侧**必须走同一个函数**取键。 */
export function articleKey(law: string | null | undefined, article: string): string {
  return `${normLaw(law)}|${normalizeArticle(article)}`;
}

/** 一段文本里出现的全部条号引用键（`法名|条号`；没写法名时法名为空串）。 */
function articleKeysIn(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(ARTICLE)) {
    const raw = m[0].replace(/\s+/g, '');
    const law = /《([^》]{2,40})》/.exec(raw)?.[1] ?? '';
    // 走唯一真源出键：档案里写「第46条第2项」、卡里存「第四十六条」，必须归一到同一个键，
    // 否则 ⭐ 核心条块匹配不上 → 模型收不到"这条要引全"的指令（本次 bug 的行为侧一半）
    out.add(articleKey(law, raw.replace(/《[^》]{2,40}》/, '')));
  }
  return out;
}

/** ⭐**封顶**条数。是封顶不是配额——命中 2 条就给 2 条，不许凑数。 */
const S2_CAP = 3;

/** 场景映射卡的 id。映射表本身是知识库里的一张方法卡，不是代码里的常量表。 */
export const CORE_ARTICLE_MAP_PACK_ID = 'method-core-article-map';

/**
 * 【S3 档】按场景取出**声明的**核心依据条（`法名|条号` 有序数组）。
 *
 * 【为什么需要它】S2 的「按检索得分序取前 3」衡量的是**这张卡贴不贴题**，
 * 不是**这一条是不是本案的钱袋子**。实测 S03 三跑：得分序把《司法解释（二）》§3/§6/§7
 * 排在前面，把真正决定补偿的《劳动合同法》§46 挤出了封顶——排序副产品当不了核心条判据。
 *
 * 【匹配规则】`(scene, claim_kind)` 精确命中优先，命中不到退 `scene` 单键。
 * 首诊轮 `claims` 为空天然走单键——那正是本档要覆盖的那一轮。
 * 两个键都取自**已有结构化字段**（`cases.stage` / `claims.kind`），不新增任何模型判断。
 */
export function sceneCoreArticles(
  mapPack: Pick<KnowledgePack, 'facts'> | undefined,
  scene: string | null | undefined,
  claimKinds: readonly string[] = [],
): string[] {
  const rows = mapPack?.facts?.core_article_map ?? [];
  if (!scene) return [];
  const hit =
    rows.find((r) => r.scene === scene && r.claim_kind && claimKinds.includes(r.claim_kind)) ??
    rows.find((r) => r.scene === scene && !r.claim_kind);
  return hit?.articles ?? [];
}

/**
 * 本轮的**核心依据条**（`法名|条号` 集合），**由结构化事实判定，不让模型自己勾**。
 *
 * 【为什么必须结构化判定】（manager 2026-08-23 落地约束）
 * 「哪几条是核心」如果交给模型自己判断，等于把分层的判定权交还给我们本想约束的那一方——
 * 它会把"我打算详细讲的"标成核心，而不是"用户拿去主张权利要用的"。
 *
 * 【三档来源，S1 恒优先】（manager 2026-08-24 专议裁定）
 *   **S1（档案三来源）**：① `claims.basis`——claim_calc 落库时写的法条串（**这是钱的依据**，
 *     用户会拿它去主张）；② 行动卡 detail 里的条号（行动卡是「现在做什么」，其依据必然核心）；
 *     ③ 生效中的期限推算依据（`deadlines.derived_from`）。
 *     **只要 S1 出得来一条，本轮就完全走 S1**，S2/S4 一律不参与——老路径输出零变化。
 *   **S3（场景映射）**：S1 全空时，`method-core-article-map` 卡按 `(cases.stage, claims.kind)`
 *     声明的核心条，**命中取料面的优先占用**封顶名额（见 sceneCoreArticles）。
 *   **S2（检索候选）**：取本轮注入包里 `facts.statute_quotes` 非空的条目，**按检索得分序**
 *     把 S3 之后的剩余空位**补足**到 `S2_CAP` 条。
 *   **S4（用户点名）**：用户这轮消息里正则可取的条号，命中候选池就**必入**且**不占上限**；
 *     库内没有那一条就**不入**⭐（回答层由第五闸走「待核实」口径，不在本函数）。
 *
 * 【为什么只有 S4 不占上限（manager 2026-08-25 纠正）】不占上限的特权来自
 * **「用户点名必答」是问答基线**——那是用户自己提的问题，不答就是没回答他。
 * S3 是**系统自己的判断**，没有这个特权；给了它追加配额，⭐会膨胀到 5–6 条，
 * 击穿「封顶 3 = 首诊信息密度」的原裁定。**映射的本质是排序/优先权，不是追加配额。**
 *
 * 【为什么首诊必须有 S2 而不是让⭐整段消失】首诊三来源天然全空 → ⭐段整段不输出 →
 * 模型收不到"哪条是核心"的信号，而首诊恰恰是它最需要这个信号的一轮。
 * 检索得分序是**已经算好的结构化事实**，拿它当候选与"让模型自己提名"是两回事：
 * 本函数每一步的输入都是结构化事实，输出是确定性函数，**模型零提名权**。
 *
 * 【它解决的是什么】S03#2：同一回复对《调解仲裁法》§27 引了全文、对《实施条例》§27 只给条号，
 * 而后者恰恰是**结论句同句**的那条（补偿基数）。模型不是不会引，是**不知道哪条值得引全**。
 * 与其加一条"每条都必须带原文"的粗规则（会盖掉核心/辅助分层与 pending 三分支），
 * 不如**把"哪条是核心"从模型的判断变成注入的事实**——降低正确行为的成本，而不是提高错误行为的代价。
 */
export interface CoreArticleSources {
  claims?: { basis: string | null }[];
  openActions?: { detail: string | null }[];
  deadlines?: { derived_from: string | null }[];
  /**
   * 候选池的取料面：**预检索注入包 ∪ 本轮已进上下文的卡**，顺序即检索得分序。
   * 产线两条通路各自现取——注入侧传 `input.packs`，工具侧传 `state.retrieved`。
   */
  retrieved?: Pick<KnowledgePack, 'facts'>[];
  /** 本轮用户原话（S4 点名的取料面） */
  userMessage?: string;
  /**
   * 【S3 档】本场景声明的核心依据条（`sceneCoreArticles` 的产出，有序）。
   * 语义是**优先权**：命中取料面的按此序**优先占用**封顶名额，剩余空位才由 S2 补足。
   */
  sceneArticles?: string[];
}

export function coreArticleKeys(input: CoreArticleSources): Set<string> {
  const out = new Set<string>();
  const collect = (text: string | null | undefined) => {
    for (const k of articleKeysIn(text)) out.add(k);
  };
  for (const c of input.claims ?? []) collect(c.basis);
  for (const a of input.openActions ?? []) collect(a.detail);
  for (const d of input.deadlines ?? []) collect(d.derived_from);
  if (out.size > 0) return out; // S1 恒优先

  // 候选池 = 本轮注入包里带逐字原文的法条条目。S3/S2/S4 都只在这个池子里取，
  // 池外的条号一律不入⭐——⭐ 是"这条要引全"的指令，指向一条手上没有原文的条毫无意义。
  const quotes = (input.retrieved ?? []).flatMap((p) => p.facts?.statute_quotes ?? []).filter((q) => q?.law && q?.article && q?.text);
  const inPool = new Map(quotes.map((q) => [articleKey(q.law, q.article), q]));
  // S3 先占：映射声明的顺序即优先级，池外的跳过（点名一条手上没原文的条毫无意义）
  for (const key of input.sceneArticles ?? []) {
    if (out.size >= S2_CAP) break;
    if (inPool.has(key)) out.add(key);
  }
  // S2 补位：按检索得分序把剩余空位填到封顶为止。总数恒 ≤ S2_CAP
  for (const q of quotes) {
    if (out.size >= S2_CAP) break;
    out.add(articleKey(q.law, q.article));
  }
  const named = articleKeysIn(input.userMessage);
  // 用户没写法名时键是 `|第46条`，故两种键都比一遍（与 isCoreBlock 同一套匹配口径）
  for (const q of quotes) {
    if (named.has(articleKey(q.law, q.article)) || named.has(articleKey(null, q.article))) out.add(articleKey(q.law, q.article));
  }
  return out;
}

/** 该引用块讲的是不是核心条 */
function isCoreBlock(law: string, article: string, core: Set<string>): boolean {
  // 卡侧与引用侧同函数取键——这是"两处各写一份会静默漂移"的根治
  return core.has(articleKey(law, article)) || core.has(articleKey(null, article));
}

/**
 * 这张卡里**会被打上⭐**的那些条（= 渲染进 prompt 的核心条）。
 *
 * 【为什么单独抽出来】"候选池里有" ≠ "模型真的收到了⭐标注"：候选池里的条若在本轮
 * 注入的卡里没有 `statute_quotes`，⭐段根本不会出现它。可观测接口要能把这两者分开
 * （`coreCandidateKeys` vs `coreBlockRendered`）——**S03 那次就是候选池空、⭐段没出现，
 * 而报告写成"给了"**，当时没有任何字段能证伪。
 *
 * 抽出来给 orchestrator 复用，而不是让它照着 packCitationGuide 再判一遍：
 * 两份实现必有一天分叉，那时"我们以为渲染了"和"实际渲染了"又会各说各话。
 */
export function coreQuotesOf(pack: KnowledgePack, core: Set<string>) {
  return (pack.facts?.statute_quotes ?? []).filter((q) => q?.law && q?.article && isCoreBlock(q.law, q.article, core));
}

/** 本轮**实际渲染进 prompt** 的⭐核心条键集（跨全部注入卡去重） */
export function coreBlockRenderedKeys(packs: KnowledgePack[], core: Set<string>): string[] {
  const out = new Set<string>();
  for (const p of packs) for (const q of coreQuotesOf(p, core)) out.add(articleKey(q.law, q.article));
  return [...out];
}

export function packCitationGuide(pack: KnowledgePack, core: Set<string> = new Set()): string {
  const quotes = pack.facts?.statute_quotes ?? [];
  const coreHere = coreQuotesOf(pack, core);
  const blocks = [...statuteBlocks(pack), ...valueBlocks(pack), ...precedentBlocks(pack)];
  if (blocks.length === 0) return citationTemplate(pack);
  const head = ['【本卡可引用内容已替你拼好，照抄即可（不要改写、不要缩写、不要只留编号）】'];
  if (coreHere.length > 0) {
    head.push(
      '',
      // 来源规则见 coreArticleKeys：S1 档案三来源恒优先，S1 空时取 S2 检索候选（封顶 3），
      // S4 用户点名的条命中候选池必入且不占上限。这里只呈现结果，不让模型参与提名。
      `⭐ **本轮核心依据条**（依据来源：档案里的诉求金额/行动卡/期限直接依赖的条；档案还空时取本轮检索命中的法条，以及你这轮点名问到的条）：` +
        coreHere.map((q) => `《${q.law.replace(/^《|》$/g, '')}》${q.article}`).join('、'),
      '**这几条必须带逐字原文引用**——用户要拿它们去主张权利、当庭念出来；只给条号等于没给。',
      '其余条文可只给条号 + 一句大意。',
    );
  }
  return [...head, '', blocks.join('\n\n')].join('\n');
}

// ───────────────────────── 出口侧：光秃条号检测 ─────────────────────────

/** 条号形态：《X法》第Y条 / 第Y条 / 第Y款。 */
const ARTICLE = /(?:《[^》\n]{2,30}》\s*)?第\s*[一二三四五六七八九十百零〇0-9]{1,6}\s*条(?:第\s*[一二三四五六七八九十0-9]{1,3}\s*[款项])?/g;
/** 引号内的一段（中文/直角/英文引号通吃） */
const QUOTED = /[「“"]([^」”"\n]{1,200})[」”"]/g;
/**
 * 引号里多长才算「逐字原文」而不是「加引号的术语」。
 *
 * 【这个阈值是被一句真实转录逼出来的】S09 那句
 * 「依《劳动合同法》第 39 条第 2 项，可能被认定"**严重违反规章制度**"解除」——
 * 附近确实有引号，但引的是一个 8 字的**术语**，不是条文。首版只要"附近有引号"就放过，
 * 于是这句货真价实的光秃引用被判成合格。条文原文没有这么短的
 * （最短的「用人单位未及时足额支付劳动报酬的」也有 16 字），术语则普遍在 10 字以内。
 */
const VERBATIM_MIN_LEN = 12;
/** markdown 引用行：整行以 > 开头，是逐字原文最规范的载体 */
const BLOCKQUOTE = /^\s*>/m;

/**
 * 我们**自己注入块**的标准格式：`第二十七条　劳动合同法第四十七条规定的…`
 * ——条号 + **全角空格** + 正文。这是 statuteBlocks() 拼出来的形状，
 * 引用它本身就是「带了逐字原文」，不该被判光秃。
 * 【为什么单独认】它既没有引号也不在 blockquote 里，靠通用规则识别不出来——
 * **判据不认识自家产出的格式**，就会把最规范的那种引用judged成最差的。
 */
const OWN_QUOTE_FORMAT = /第[一二三四五六七八九十百零〇0-9]+条[　\u3000][^\n]{10,}/;
/** 同上，全局版——用来定位「落在自家格式原文内部」的交叉引用 */
const OWN_QUOTE_FORMAT_G = /第[一二三四五六七八九十百零〇0-9]+条[　\u3000][^\n]{10,}/g;

/**
 * 一段"疑似逐字原文"到底在讲哪几条：取其中出现的全部条号（归一后，不带法名）。
 * 空集 = 这段原文没自报条号。
 */
function articlesIn(span: string): Set<string> {
  const out = new Set<string>();
  for (const m of span.matchAll(ARTICLE)) {
    out.add(normalizeArticle(m[0].replace(/\s+/g, '').replace(/《[^》]{2,40}》/, '')));
  }
  return out;
}

/**
 * 这段**无引号的**逐字原文能不能给「第 X 条」免责。
 *
 * 【为什么要问归属（4e10b7c 批 S03#2 实测）】原文：
 *   `……给的是 N（第四十六条第（二）项）。但如果是公司违法解除——`
 *   `> 第八十七条　用人单位违反本法规定解除或者终止劳动合同的……`
 * §46 是**光秃引用**，可 ±60 窗口里落进了讲 **§87** 的那行 blockquote，
 * 旧实现只问"窗口里有没有 blockquote"，于是**邻条的原文替本条免了责**——
 * 机械判据报全过、judge 报 FAIL，两层结论相反，正是发版前被拦下的那个读数。
 *
 * 【判定与保守方向】原文自报了条号 → 必须**是本条**才算数；
 * 原文**没自报任何条号** → 仍然放行。后者是有意的：判据误判是冤枉一次做对了的输出，
 * 方向上**宁可漏判**（与闸门的"宁可少说"相反，见 stripUnsupportedQuotes 注释）。
 */
function unquotedVerbatimCovers(span: string, article: string): boolean {
  const self = SELF_LABELED.exec(span);
  return !self || normalizeArticle(self[1]) === article;
}

/**
 * 这段原文**自报**了自己是第几条：`> 第八十七条　用人单位…`——条号打头 + 全角空格，
 * 正是卡里 `statute_quotes.text` 的存储形态（也是 statuteBlocks() 拼出来的形态）。
 *
 * 【为什么只认"打头"，不认段内任意条号（4e10b7c 批 S14#2 两处误报）】法条原文**内部**
 * 交叉引用别的条是立法常态：§87 的原文里写着"依照本法**第四十七条**规定的…"，
 * 实施条例§27 的原文以"**劳动合同法第四十七条**规定的经济补偿…"开头。
 * 若把段内任意条号都当成"这段在讲那一条"，下面这种**最规范**的引用形态会被判光秃：
 *   `《劳动合同法》第八十七条：`
 *   `> 用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条…`
 * ——标题行点名、紧跟的 blockquote 给原文，段内那个 §47 只是立法者的交叉引用。
 *
 * 只认打头即可区分它与 S03#2 那种真误免责（`> 第八十七条　…` 自报是 §87，
 * 替不了隔壁那个光秃的 §46）。取不到打头条号 → 归属未知 → 放行（宁可漏判）。
 */
// 【《法名》前缀（2026-08-25 补）】真语料里最规范的给法形态是
// `> 《劳动合同法》第八十七条　用人单位违反本法规定解除…`（S15 轮1 实测）。
// 不认前缀 → 该行"取不到打头条号" → 归属未知 → 按下面的宽容规则放行，于是它既替不了自己、
// 也拦不住别人；轮级预扫改成**严格正向归属**后，不扩前缀就会把 S15 那条从平反退回 FAIL——
// **修一个洞不能靠制造一次冤枉来完成**（lead 2026-08-25 批）。
const SELF_LABELED = /^\s*>?\s*(?:《[^》]{2,40}》)?\s*(第[一二三四五六七八九十百零〇0-9]+条)[　\u3000]/;

/**
 * 该位置是否落在**自家注入块格式**（`第二十七条　正文…`）的**正文内部**。
 *
 * 【与 insideVerbatim 同一条道理，只是载体不同】法条原文自己会交叉引用别的条：
 * 实施条例§27 的正文写着"劳动合同法**第四十七条**规定的经济补偿"。
 * 那个 §47 是**立法者写的**，不是 agent 的光秃引用——判它"没带原文"
 * 等于要求把被引法条的原文也一并附上，无限递归。
 * insideVerbatim 只认引号与 blockquote 两种载体，认不出无引号的自家格式。
 */
function insideOwnFormatQuote(text: string, at: number): boolean {
  for (const m of text.matchAll(OWN_QUOTE_FORMAT_G)) {
    const start = m.index ?? 0;
    // 打头那个条号本身要判（它才是这段原文的主语），正文里的交叉引用才跳过
    if (at > start && at < start + m[0].length) return true;
  }
  return false;
}

/**
 * 一行文字**打头点名**的条号（归一化后）；没点名返回 null。
 *
 * 打头 = 去掉 blockquote 标记与可选《法名》后，条号出现在最前，且后接
 * 全角空格／冒号／行尾——这三种是真语料里给原文的全部形态：
 *   `> 第四十六条　有下列情形…`（卡内 statute_quotes 的存储形态）
 *   `> 《劳动合同法》第八十七条　用人单位违反…`（S15 轮1）
 *   `《劳动合同法》第38条：用人单位有下列情形…`（S07 轮1）
 * **关键在"打头"**：`> （一）劳动者依照本法第三十八条规定解除劳动合同的；`
 * 打头的是「（一）」不是条号，故取不到——那行是 §46 的项，不是"讲 §38 的原文"。
 */
const HEAD_LABEL = /^\s*>?\s*(?:《[^》]{2,40}》)?\s*(第[一二三四五六七八九十百零〇0-9]+条)(?:[　　：:]|$)/;

function headLabeledArticle(line: string): string | null {
  const m = HEAD_LABEL.exec(line);
  return m ? normalizeArticle(m[1]) : null;
}

/**
 * blockquote 行归属的条号：先看它自己打头点名，再回溯到**上一个非引用行**的点名。
 *
 * 回溯是必需的——最规范的给法是标题行点名、紧跟的引用行只有正文：
 *   `《劳动合同法》第四十六条：`
 *   `> 有下列情形之一的，用人单位应当向劳动者支付经济补偿：（一）…第三十八条…`
 * 只认自报会把这种形态判成"没给过"，反过来制造冤枉；而回溯到标题行拿到的是 §46，
 * **那行里的 §38 仍然拿不到归属**——洞照样堵着。
 */
function quoteAttribution(lines: string[], idx: number): string | null {
  const own = headLabeledArticle(lines[idx]);
  if (own) return own;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = lines[i];
    if (/^\s*>/.test(prev)) continue; // 同一段引用的上一行，继续往上找标题
    if (!prev.trim()) return null; // 空行截断：隔了空行的标题不再算这段引用的题头
    return headLabeledArticle(prev);
  }
  return null;
}

/**
 * 轮级预扫专用：这段窗口里有没有**明确归属于本条**的逐字原文。
 *
 * 【与本地窗口判定的关键差别：严格正向归属（2026-08-25 修）】
 * 本地路径的 `unquotedVerbatimCovers` 有一条宽容规则——**取不到打头条号 → 归属未知 → 放行**
 *（宁可漏判，判据侧的保守方向）。那条规则在本地的爆炸半径是 ±60；
 * **搬到轮级就变成整轮**——同一条规则，作用域一换，风险量级完全不同。
 *
 * 实测（真语料 S03 轮1 + 最小构造）：§46 的逐字原文里有一行是
 *   `> （一）劳动者依照本法第三十八条规定解除劳动合同的；`
 * 它**取不到打头条号**（法条的项/款行天然不自报），于是"归属未知"被当成"归属成立"，
 * **§38 被登记进本轮已给全文集合，整轮豁免**——4e10b7c 修掉的"邻条原文替本条免责"
 * 就从轮级这条路重新打开了：后文任何一处光秃引 §38/§40 都会被放行。
 *
 * 所以轮级这一侧**必须正向**：原文自报了条号、且**正是本条**，才算"本轮给过它的全文"。
 * 未知一律不算——**未知不是已给**（同 A3「不知道 ≠ 零」）。
 */
function hasAttributedVerbatim(near: string, article: string): boolean {
  const lines = near.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*>/.test(lines[i]) && quoteAttribution(lines, i) === article) return true;
  }
  const own = OWN_QUOTE_FORMAT.exec(near);
  return !!own && headLabeledArticle(own[0]) === article;
}

function hasVerbatimNear(near: string, article: string): boolean {
  // blockquote 行：逐行取内容问归属，不再"窗口里有 > 就整窗放行"
  for (const line of near.split('\n')) {
    if (/^\s*>/.test(line) && unquotedVerbatimCovers(line, article)) return true;
  }
  const own = OWN_QUOTE_FORMAT.exec(near);
  if (own && unquotedVerbatimCovers(own[0], article)) return true;
  // 引号内的逐字原文**不问归属**：法条原文自己会交叉引用别的条
  //（§46 第(二)项的正文里就写着"依照本法第三十六条规定"），问归属会把正确引用判成光秃。
  for (const q of near.matchAll(QUOTED)) {
    if (q[1].trim().length >= VERBATIM_MIN_LEN) return true;
  }
  return false;
}

/**
 * 该位置是否落在**逐字原文内部**（引号内或 blockquote 行内）。
 *
 * 【为什么要排除】法条原文自己会**交叉引用**别的条：
 * §87 的原文里写着「应当依照本法**第四十七条**规定的经济补偿标准的二倍」。
 * 那个「第四十七条」是**立法者写的**，不是 agent 自己给的光秃引用——
 * 判它「没带原文」等于要求 agent 把被引法条的原文也一并附上，无限递归。
 */
function insideVerbatim(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  if (/^\s*>/.test(text.slice(lineStart, at))) return true; // blockquote 行
  // 引号内：数该位置之前同一行有几个引号，奇数即在引号内
  const before = text.slice(lineStart, at);
  const marks = (before.match(/["「『“”」』]/g) ?? []).length;
  return marks % 2 === 1;
}

/**
 * 找出正文里**只给了条号、附近没有逐字原文**的引用（G4 失败的主形态）。
 *
 * 【窗口必须双向】中文两种语序都自然：
 * 「《劳动合同法》第38条："用人单位有下列情形之一的…"」——原文在**后**；
 * 「"用人单位未及时足额支付劳动报酬的"（《劳动合同法》第38条）」——原文在**前**。
 * 只查一侧就是教训 8 的第 N 次重演（那次预设的不是词，是位置）。
 *
 * 【这是运维信号，不是闸门】返回值只用来发 notice 留痕，**不剥除、不改写正文**：
 * 引用不完整是"给少了"，不是"给了有害的东西"，剥掉只会让用户连条号都拿不到。
 * 与案号闸门（编造 → 必须拦）分属两类，统计口径也分开。
 */
/** 判例引用的标记：案例N / 典型案例 / 案号 / 「X 诉 Y」 */
const PRECEDENT_MARK = /案例\s*[一二三四五六七八九十0-9]+|典型案例|[（(]\s*\d{4}\s*[）)][一-龥A-Za-z0-9]{2,20}号|[一-龥]{1,4}某\s*诉/;
const CJK_RUN = /[一-鿿]+/g;

function grams(text: string, n = 3): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n));
  }
  return out;
}

/**
 * 【ISSUE-03 (c) 出口侧留痕】判例引用**句**里混进了「本案用户事实里有、判例卡里没有」的内容。
 *
 * 与评测侧 `precedentContaminationAssertions` **判据同源、同一个形态**：
 * 按句隔离（相似点该另起一句）→ 三方比对（在判例句 ∧ 在用户事实 ∧ 不在卡）。
 * 两边算的必须是同一件事，否则会出现「产线报了评测不报」或反过来（教训 11）。
 *
 * 【只留痕，不改正文】与光秃条号同一条纪律：这是「多给了不属于它的内容」，
 * 剥掉会把整段判例分析弄得莫名其妙。真正的防线是注入侧的判例引用块（模板化拼装）
 * 与提示词里那条「判例段只复述卡里写的」。
 *
 * 【已知限制】3-gram 比对抓得住**抄词**，抓不住**转述**——
 * 实测那段真实污染里，「次日报到」是模型把用户的「第二天」「明早」改写出来的，字面看不见。
 * 所以这是筛子不是闸门，judge 的语义判断不能撤。
 */
export function precedentContamination(text: string, cards: KnowledgePack[], userFacts: string): string[] {
  if (!userFacts.trim() || cards.length === 0) return [];
  const cardGrams = grams(cards.map(packCorpus).join('\n'));
  const factGrams = grams(userFacts);
  const dirty = new Set<string>();
  for (const s of text.split(/[。！？\n]/)) {
    if (!s.trim() || !PRECEDENT_MARK.test(s)) continue;
    for (const g of grams(s)) if (factGrams.has(g) && !cardGrams.has(g)) dirty.add(g);
  }
  return [...dirty];
}

/**
 * 引用**位置**的口径：核心位 vs 辅助位（manager 2026-08-25 定，产线与判据同源）。
 *
 * 【为什么位置决定后果】同一个光秃条号，落在不同位置对用户的伤害完全不同：
 * - **核心位**：行动卡的「为什么（依据）」、`claims.calc_json.basis`、以及**结论句紧邻**
 *   （"给的是 N（第四十六条）"）。用户会拿着这一处去主张权利、当庭念出来，
 *   只给编号等于**空手**——这才是 G4 要罚的那件事。
 * - **辅助位**：表格行、列举句、旁引（"第 40 条（不胜任/客观情况变化）"这种**说明性**提及）。
 *   这里给条号 + 一句大意本来就是我们**要求**的写法（见 packCitationGuide 的"其余条文可只给条号"）。
 *   罚它等于罚我们自己定的分层，还会把模型逼进**防御性省略**——干脆不提条号最安全，
 *   那才是真正的损失。
 *
 * 【保守方向】判不准就算辅助位。G4 是质量项不是红线，误判的代价是把模型逼向防御性省略、
 * 把修向指错（这几天的主线教训），所以方向上**宁可漏判**。
 *
 * 【行动卡 basis 不走本函数】那是**结构化字段**，字段语义即依据，调用方直接按核心位处理。
 */
export type CitationSite = '核心位' | '辅助位';

/** 结论标记：金额、倍数（N / 2N / N+1）、权利主张断言。命中即认为该处在下结论。 */
const CONCLUSION_NEAR =
  /(?:^|[^A-Za-z0-9])(?:2\s*N|N\s*\+\s*1|N)(?:[^A-Za-z0-9]|$)|[\d.]+\s*万|\d[\d,]{2,}\s*元|应当(?:向劳动者)?支付|可以(?:要求|主张)|赔偿金|二倍/;

export function citationSite(text: string, at: number, windowSize = 60): CitationSite {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  // 表格行：整行是 markdown 表格，天然是"并列摆事实"，不是结论落点
  if (/^\s*\|/.test(line)) return '辅助位';
  const near = text.slice(Math.max(0, at - windowSize), at + windowSize);
  return CONCLUSION_NEAR.test(near) ? '核心位' : '辅助位';
}

/**
 * 本轮里**由 agent 自己写下**的条号引用（法条原文内部的交叉引用不算——那是立法者写的）。
 *
 * 【为什么把取材面单独抽出来（2026-08-25）】判据与渲染**共用取材、各加各的过滤**：
 *   · 判据（`bareArticleSpans`）再过一道**归属**过滤 —— 它问的是「模型有没有给依据」；
 *   · 渲染（`renderCoreArticleFallback`）过的是**内容**过滤 —— 它问的是「原文在不在正文里」。
 * 两者从这里分岔，而不是让渲染去消费判据的结论。
 */
function authoredCitationSpans(
  text: string,
  windowSize: number,
): { raw: string; at: number; end: number; article: string; site: CitationSite }[] {
  const out: { raw: string; at: number; end: number; article: string; site: CitationSite }[] = [];
  for (const m of text.matchAll(ARTICLE)) {
    const at = m.index ?? 0;
    if (insideVerbatim(text, at)) continue;
    if (insideOwnFormatQuote(text, at)) continue;
    const raw = m[0].replace(/\s+/g, '');
    const article = normalizeArticle(raw.replace(/《[^》]{2,40}》/, ''));
    // end 用**原始匹配**的长度，不是去空格后的 raw.length（A20 归一化镜像：
    // 取值/做键用归一形，定位/插入用原始位置）。模型写「第 38 条」时两者差 2，
    // 用错就会把条号切开插进去：`第 38「…原文…」条`。
    out.push({ raw, at, end: at + m[0].length, article, site: citationSite(text, at, windowSize) });
  }
  return out;
}

export function bareArticleCitations(text: string, windowSize = 60): string[] {
  return bareArticleSpans(text, windowSize).map((x) => x.raw);
}

/** 同 bareArticleCitations，但带上**位置与偏移**——判据按位置分级、产线按位置补原文都要用它。 */
export function bareArticleSpans(text: string, windowSize = 60): { raw: string; at: number; article: string; site: CitationSite }[] {
  // 【判定单位是「本轮」，不是「窗口」】(缺陷① 2026-08-25)
  // 真实形态是**前文已给全文、后文再回指同一条**（S03#1 §46 全文在 16 行外；S15轮1 §87 同族）。
  // 按窗口判会把回指判成光秃——而用户其实已经拿到原文了。
  //
  // 修法**不是放大窗口**：放大是给参数找例外（A7），且会把**邻条**原文误算成本条。
  // 改的是判定单位——先扫一遍全文，记下"本轮哪些条已经给过全文"，回指命中即不算光秃。
  const givenFullText = new Set<string>();
  for (const m of text.matchAll(ARTICLE)) {
    const at = m.index ?? 0;
    const article = normalizeArticle(m[0].replace(/\s+/g, '').replace(/《[^》]{2,40}》/, ''));
    const near = text.slice(Math.max(0, at - windowSize), at + m[0].length + windowSize);
    // 【预扫只认**归属明确**的覆盖】窗口判定里"引号内原文不问归属"是刻意的
    //（法条原文自己会交叉引用别的条，问归属会把正确引用判成光秃）——但那条豁免只能作用在**本地**。
    // 若把它带进轮级集合，一次局部误覆盖就会**扩散成整轮豁免**：邻条 §46 的引文
    // 会让全文任何位置的 §47 都不再算光秃。所以预扫只收 blockquote / 自家格式这两条**问过归属**的路径。
    if (hasAttributedVerbatim(near, article)) givenFullText.add(article);
  }

  const out: { raw: string; at: number; article: string; site: CitationSite }[] = [];
  for (const span of authoredCitationSpans(text, windowSize)) {
    const { raw, at, article } = span;
    if (givenFullText.has(article)) continue; // 轮级：本轮任何位置**归属明确地**给过全文 → 回指不算光秃
    // 本地窗口判定照旧保留（含"引号内原文不问归属"那条本地豁免）
    const near = text.slice(Math.max(0, at - windowSize), at + raw.length + windowSize);
    if (hasVerbatimNear(near, article)) continue;
    out.push(span);
  }
  return out;
}

/**
 * 【核心位保底渲染】把⭐核心条在**核心位**的光秃引用，就地补上卡内逐字原文。
 *
 * 【为什么这一步不该交给模型自觉（manager 2026-08-25）】到这里，三件事系统全都已经知道：
 *   · 哪几条是核心条 —— ⭐清单（coreArticleKeys，确定性函数）；
 *   · 它们的逐字原文 —— 就在本轮注入的卡里（`facts.statute_quotes`）；
 *   · 这一处是不是核心位 —— citationSite（判据与产线同一个函数）。
 * 三样齐了还把最后一步寄望于"模型记得引全"，就是把**已知的确定性**换成**概率**。
 * 这条修法消灭的不是某一次漏引，是**「核心位光秃」这个类别本身**。
 *
 * 【与第五闸不冲突】补进去的是卡里的逐字原文，天然在本轮注入语料内，过闸必然放行；
 * 且本函数在闸之后执行，不存在被自己剥掉的可能。
 *
 * 【触发条件：原文在手就补，⭐只定优先级（2026-08-25 修正，见下）】
 * 核心位 ∧ 光秃 ∧ 该条逐字原文在本轮注入包里 ∧ 全文任何位置都没有它 → 补。
 * 辅助位不动（那里给条号 + 一句大意本就是要求的写法）、已带原文的不重复补、
 * 一轮封顶 `RENDER_CAP` 条（⭐清单内的优先占额度），防止把回复灌成法条汇编。
 *
 * 【为什么触发条件不是"⭐清单内"（c0680d3 批 S14#1 实测）】首版按"⭐清单内"设门，
 * 结果那一跑挂在 §40：S14 夹具 stage=`风声`，映射行声明的是 §46/§47/实施条例§27，
 * 三条把 cap=3 占满 → §40 进不了⭐ → 渲染按设计跳过 → 用户面前留下
 * 「N+1（第40条第3项）」这么个光秃结论，而 §40 的逐字原文**就在本轮注入包里**。
 *
 * ⭐的 cap 服务的是**给模型的信号密度**（首诊别让它觉得什么都重要）；
 * 而本函数在**出口侧**跑，此时模型已经自己选择在核心位引用了这一条——
 * "信号密度"的考量在这里已经不适用，用户要的只是**手上那份原文出现在他念得到的地方**。
 * 两个目标不同，cap 不该越界约束第二个。
 */
export function renderCoreArticleFallback(
  text: string,
  core: Set<string>,
  injected: KnowledgePack[],
): { text: string; added: string[] } {
  /** 本轮手上**有逐字原文**的全部条：`法名|条号` → 原文（去掉打头条号，便于内联） */
  const available = new Map<string, string>();
  for (const p of injected) {
    for (const q of p.facts?.statute_quotes ?? []) {
      if (!q?.law || !q?.article || !q?.text?.trim()) continue;
      const key = articleKey(q.law, q.article);
      if (!available.has(key)) available.set(key, q.text.replace(SELF_LABELED_HEAD, '').trim());
    }
  }
  if (available.size === 0) return { text, added: [] };

  const corpus = normQuote(text);
  const seen = new Set<string>();
  const picked: { at: number; key: string; quote: string }[] = [];
  // 【触发看"原文在不在"，不看判据说光不光秃（2026-08-25 manager 批）】
  //
  // **判据管评价，渲染管交付。** 评价标准可以争论（什么算"给了依据"有解释空间：
  // 自报条号算不算、标题行点名算不算、转述算不算）；**交付标准不能含糊**——
  // 原文在不在用户手里，是就是，不是就不是。共用一个判定，等于让**可争论的东西
  // 决定不可含糊的东西**，那正是根源。
  //
  // 实例（ws2-agent 自查报出）：「标题行点名《劳动合同法》第四十条 + 引用块给的是**转述**」
  // 在归属层面算"已给依据"，于是旧触发条件跳过它——而用户手里**根本没有那段原文**，
  // 拿着一句转述上不了庭。改看内容后，这一处会把逐字原文补上。
  //
  // 【不要"优化"掉重复】正文里同时出现转述与原文**是好的法律写作**（manager 定性）：
  // 先用人话讲清楚，再给可照念的原文——两段服务的是两个不同的时刻，
  // **理解的时候**，和**站在庭上的时候**。看起来重复，承担的功能不同。
  for (const span of authoredCitationSpans(text, 60)) {
    if (span.site !== '核心位') continue;
    // 键可能带法名也可能不带（"第46条"），两种都试——与 isCoreBlock 同一套匹配口径
    const key = [...available.keys()].find(
      (k) => k === articleKey(null, span.raw.replace(/《[^》]{2,40}》/, '')) || k.endsWith(`|${span.article}`),
    );
    if (!key || seen.has(key)) continue;
    // 引用点名了第 N 项就只补那一项：模型引的是"第40条第3项"，用户要念的也是那一项，
    // 把七个子项整段糊上去，等于用噪音淹掉他真正要用的那一句。
    const quote = subItemOf(available.get(key)!, span.raw) ?? available.get(key)!;
    if (corpus.includes(normQuote(quote))) continue; // 全文已有该条原文，不重复补
    seen.add(key);
    picked.push({ at: span.end, key, quote });
  }
  // ⭐清单内的优先占额度，其余按出现先后；每轮封顶 RENDER_CAP 条，防止把回复灌成法条汇编
  picked.sort((a, b) => Number(core.has(b.key)) - Number(core.has(a.key)));
  const chosen = picked.slice(0, RENDER_CAP).sort((a, b) => b.at - a.at); // 倒序插入，免得偏移被顶掉
  let out = text;
  for (const c of chosen) out = `${out.slice(0, c.at)}「${c.quote}」${out.slice(c.at)}`;
  return { text: out, added: chosen.map((c) => c.key) };
}

/** 一轮最多补几条。核心位光秃本就稀少（实测一轮 1 处），封顶只是防失控的护栏。 */
const RENDER_CAP = 3;

/**
 * 引用点名了「第 N 项」时，从整条原文里切出**那一项**。
 * 取不到（没点名、或原文里找不到该项）返回 null，调用方退回整条。
 */
function subItemOf(quote: string, raw: string): string | null {
  const m = /第\s*([一二三四五六七八九十0-9]{1,3})\s*项/.exec(raw);
  if (!m) return null;
  const want = cnNumeral(m[1]);
  if (want === null) return null;
  for (const seg of quote.matchAll(/（([一二三四五六七八九十0-9]{1,3})）[^（]*/g)) {
    if (cnNumeral(seg[1]) === want) return seg[0].trim();
  }
  return null;
}

/** 卡里 statute_quotes.text 打头的那个条号（`第四十六条　`），内联引用时去掉，免得"第四十六条「第四十六条　…」" */
// 打头条号允许被 markdown 强调包裹：真卡里存的是 `**第三十八条**　用人单位…`，
// 不认强调标记就剥不掉，补进正文会变成 `第 38「**第三十八条**　…」条` 这种叠字形态。
const SELF_LABELED_HEAD = /^\s*(?:\*\*|__)?\s*第[一二三四五六七八九十百零〇0-9]+条(?:\*\*|__)?[　\u3000]\s*/;

// ───────────────────────── 第五道确定性闸：伪逐字引号引用 ─────────────────────────
//
// 【为什么这是 G1 零编造，不是 G4「引用不完整」】（manager 2026-08-23 定性）
// 带引号的逐字引用是**最高可信度表达**——用户会原样搬进书状、当庭念出。
// 编一个不存在的「第(4)项」，后果与编案号完全等同；**且比明显编造更危险：
// 它有真实法条名做外衣**，用户与对方律师都要查到原文才会发现不对。
//
// 三态区分：G4 =「给少了」；G1 显性 =「编造」；**本闸 =「真法条名 + 编的内容与子项」**。
//
// 实测（S14 #3，b7d0589 批）：本轮检索包 6 张卡**无任何 534/statute pack**，
// 模型却写出「第55问第(4)项："…应得工资包含由个人缴纳的社会保险费…"」——
// 卡内真身在 §55(1)、措辞不同。

/** 引号内被**当作法条原文**呈现时的两个识别条件之一：内容带法条形态 */
const STATUTE_SHAPE_IN_QUOTE =
  /第[一二三四五六七八九十百零〇0-9]+条|第[一二三四五六七八九十百零〇0-9]+问|[〔[【]\s*\d{4}\s*[〕\]】]\s*\d+\s*号|第[一二三四五六七八九十]+款/;

/** 条件之二：引号前紧跟「宣称逐字」的引导语 */
const VERBATIM_LEAD = /(原文|规定|写的是|载明|明确|条文|第\s*[一二三四五六七八九十百零〇0-9]+\s*[条问项款][^。！？\n]{0,8})[：:是]?\s*$/;

/** 非对称引号（「」『』“”）：开闭可区分，直接配对 */
const QUOTED_ASYM = /[「『“]([^」』”\n]{8,300})[」』”]/g;

/**
 * 取出所有「被引号包起来」的片段。
 *
 * 【为什么不能用一条正则通吃】真语料（S03 转录）用的是**对称的 ASCII 直引号 `"`**：
 * 「基数按前 12 个月"应得工资"，含奖金…年限从…（《实施条例》第二十七条）。第二，N 只是"公司提出…"」
 * 对称引号**开闭同形**，正则无法从字符本身判断哪个是开、哪个是闭，于是它把
 * **第 2 个引号（上一段的闭）与第 3 个引号（下一段的开）配成一对**，
 * 把中间那段**模型自己的正文**当成了"引文"——一个会剥掉正当内容的假阳性。
 *
 * 所以对称引号必须**按出现次序奇偶配对**（第 1↔2、3↔4…），不能靠正则贪心匹配。
 */
function quotedChunks(text: string): { quote: string; at: number }[] {
  const out: { quote: string; at: number }[] = [];
  for (const m of text.matchAll(QUOTED_ASYM)) out.push({ quote: m[1], at: m.index ?? 0 });
  // 对称直引号：逐行按奇偶配对，避免跨句误配
  for (const line of text.split('\n')) {
    const base = text.indexOf(line);
    const parts = line.split('"');
    // parts[1], parts[3], … 才是被引起来的内容
    let cursor = 0;
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 1 && parts[k].length >= 8 && parts[k].length <= 300) {
        out.push({ quote: parts[k], at: base + cursor + 1 });
      }
      cursor += parts[k].length + 1;
    }
  }
  return out;
}

/**
 * 引号内**被呈现为法条原文**的片段。
 *
 * 【为什么不能见引号就查】引号在我们的输出里是高频且**正当**的结构：
 * 引用户自己说过的话（charter §6 要求引具体细节）、给**可照读话术**（§6 要求给能直接念的原句）、
 * 标注「这几句绝不能说」。见引号就查会把这三类全卷进来，
 * 而它们恰恰是产品最有用的部分——**误剥会把可照读话术剥掉**。
 */
export function quotedStatuteSpans(text: string): { quote: string; at: number }[] {
  const out: { quote: string; at: number }[] = [];
  for (const { quote, at } of quotedChunks(text)) {
    const before = text.slice(Math.max(0, at - 30), at);
    if (STATUTE_SHAPE_IN_QUOTE.test(quote) || VERBATIM_LEAD.test(before)) out.push({ quote, at });
  }
  return out;
}

/** 比对前只抹排版差异，**不抹字**——「记忆改写冒充逐字」正是改了字，抹字就把要抓的东西抹没了 */
const normQuote = (s: string) => s.replace(/[\s　]/g, '').replace(/[（）()〔〕[\]【】《》""''「」『』]/g, '');

/**
 * 逐字比对的**切分单元**：句末、分号、冒号、换行。
 *
 * 【为什么冒号也要切】法条的「总述 + 适用项」写法（`……应当支付经济补偿：（二）用人单位依照……`）
 * 是引用法条最自然的形态，而卡里总述与各项之间隔着**没被引用的其它项**
 * （(一)(三)(四)…）。整块比对时这种引用必然对不上语料，被判无支撑——
 * 8101783 批 S03 三跑里 §46 的改口正是这个形态（离线复算已证：整块比对剥、按片比对放行）。
 */
const QUOTE_FRAGMENT = /[。；;：:\n]+/;

/**
 * 一个片段短到什么程度就**不再承载逐字信号**。
 *
 * 【这个阈值管的是"碎词滥配"】切分会把「的」「劳动者」这类碎片切出来，它们在任何一份法条语料里
 * 都能命中，拿它们当"有支撑"的证据等于不设防。所以**只有够长的片段才被要求逐字命中**，
 * 短片段既不作数也不否决。8 字是下限：库里最短的完整项「（七）法律、行政法规规定的其他情形」
 * 归一后 14 字，而术语普遍在 8 字以内（见 VERBATIM_MIN_LEN 那条真实语料的教训）。
 */
const MIN_FRAGMENT_LEN = 8;

/**
 * 引号内容在**本轮注入块**里有没有逐字支撑。
 *
 * 【比对单元是片段不是整块（manager 2026-08-25 裁定）】把引号块按句/分号/冒号切开，
 * **每个够长的片段各自**必须在语料里逐字命中；任一片段无支撑 → 整块无支撑。
 * 这样「总述 + 适用项」这种跳选子项的正当引用能放行，而**每一段仍然必须逐字**——
 * 改写、记忆复述、编子项内容一个都过不去（S14 那句把 §55(1) 记成「第(4)项」且措辞不同，
 * 切开后每个片段都对不上语料）。
 *
 * 【已知的强度让步，写明不藏】片段化之后，**把真片段重新排序拼起来**不再被拦
 * （整块比对能拦）。判断是：跳选子项是高频正当行为，重排真片段既罕见、后果也远轻于
 * 「编一段不存在的原文」——每个字仍是立法者写的。要拦重排得引入顺序校验，
 * 那是另一个量级的复杂度，YAGNI。
 *
 * 【为什么必须是「本轮注入」而不是「整个知识库」】S14 那轮根本没检索到 534 卡。
 * 拿全库比对会让「这轮没查却背出来」通过——而**背出来的那次恰恰最危险**：
 * 它没有经过检索，也就没有经过任何新鲜度与版本校验（子项从 (1) 记成 (4) 正是记忆复述的形态）。
 */
function quoteSupported(quote: string, corpus: string): boolean {
  const whole = normQuote(quote);
  if (corpus.includes(whole)) return true;
  const fragments = quote.split(QUOTE_FRAGMENT).map(normQuote).filter((f) => f.length >= MIN_FRAGMENT_LEN);
  // 一个够长的片段都切不出来 → 退回整块比对的结论（碎片全是短词时不能算"每段都有支撑"）
  if (fragments.length === 0) return false;
  return fragments.every((f) => corpus.includes(f));
}

export function unsupportedVerbatimQuotes(text: string, injected: KnowledgePack[]): string[] {
  const corpus = normQuote(injected.map(packCorpus).join('\n'));
  return quotedStatuteSpans(text)
    .filter(({ quote }) => !quoteSupported(quote, corpus))
    .map(({ quote }) => quote);
}

/** 改口用语：整句改口而不是换占位符——法条原文换成占位符会读不通 */
export const VERBATIM_UNVERIFIED = '（这一条我需要核实原文再引给你——我不凭记忆复述条文）';

/**
 * 把伪逐字引用**改口**，不静默删。
 *
 * 【为什么宁可改口也不留】留着的伪逐字**看起来完全可用**，用户会照抄进申请书、当庭念出来；
 * 剥掉只是少一句依据，留着是给他**一件一碰就碎的证据**。
 *
 * 【与判据侧的保守方向相反，这点必须记住】判据误判是冤枉一次做对了的输出，所以**宁可漏判**；
 * 闸门漏拦是把伪造内容交到用户手上，所以**宁可少说**。同一个「保守」，两层含义相反。
 */
/**
 * 这处引文是**在讲哪一条**：从引号往前找最近的一个条号引用。
 *
 * 【为什么要归因到条】闸剥完，正文在那一条上就变成了光秃引用，而判据分不清
 * 「模型自己没给原文」与「原文是被闸拿走的」——8101783 批 S03 #3 就把闸的行为记到了模型账上。
 * 归因到 `法名|条号` 是让下游能**只读不推断**地分账（态⑤ gate_stripped）的前提。
 *
 * 取**最后一个**匹配（离引号最近的那个），窗口与光秃判定同宽，口径一致。
 */
function articleKeyBefore(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - GATE_ATTRIBUTION_WINDOW), at);
  const all = [...before.matchAll(ARTICLE)];
  const m = all[all.length - 1];
  if (!m) return null;
  const raw = m[0].replace(/\s+/g, '');
  const law = /《([^》]{2,40})》/.exec(raw)?.[1] ?? '';
  return articleKey(law, raw.replace(/《[^》]{2,40}》/, ''));
}

/** 归因窗口，与 bareArticleCitations 的默认窗口同宽——两边讲的是同一段"附近" */
const GATE_ATTRIBUTION_WINDOW = 60;

/** 一次闸剥除的机器可读留痕：剥掉的原文 + 它归属的 `法名|条号`（取不到时为 null）。 */
export interface StrippedQuote {
  quote: string;
  articleKey: string | null;
}

export function stripUnsupportedQuotes(
  text: string,
  injected: KnowledgePack[],
): { text: string; stripped: string[]; strippedArticles: string[] } {
  const bad = unsupportedVerbatimQuotes(text, injected);
  if (bad.length === 0) return { text, stripped: [], strippedArticles: [] };
  // 归因必须在改写**之前**做：改口句一插进去，位置就全变了，前面那个条号也可能被顶出窗口
  const keys = new Set<string>();
  for (const { quote, at } of quotedStatuteSpans(text)) {
    if (!bad.includes(quote)) continue;
    const k = articleKeyBefore(text, at);
    if (k) keys.add(k);
  }
  let out = text;
  for (const q of bad) {
    // 连同包裹它的引号一起替换，避免留下半个引号
    out = out.replace(new RegExp(`[「『"“]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[」』"”]`, 'g'), VERBATIM_UNVERIFIED);
  }
  return { text: out, stripped: bad, strippedArticles: [...keys] };
}
