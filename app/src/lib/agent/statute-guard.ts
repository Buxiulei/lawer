// app/src/lib/agent/statute-guard.ts
// 条号运行时闸门（⑥，设计稿 §4.3）。与案号闸（⑤）同接口、同范式、同一条纪律。
//
// 【为什么案号有闸而条号没有，是个漏洞而不是取舍】
// 案号闸挡的是「查无此号」；条号这边此前只有 `bareArticleCitations` → 一条
// `CITATION_INCOMPLETE` 的 notice，而它**只回答"给少了"，不回答"给错了"**。
// 于是「把 §46 讲成 §47」这一类**结构上完全合格**的输出（条号形态对、法名对、
// 附近甚至有原文）一路走到用户面前，没有任何一处会报错。
// 用户拿着 §47 去主张 §46 才给的那项权利，条号是真的、这一条讲的是别的事。
//
// 【判据】与案号闸同源：**本轮 `state.retrieved` 的 `facts.statute_quotes` 里逐字有**才算真。
// 不是"这部法真的有第 47 条"（那当然有），是"本轮手上有它的原文"——
// 手上没有原文的条号，我们无从判断它讲的是不是模型说的那件事。
//
// 【为什么在流上挡】同 citation-guard.ts 文件头：正文是流式的，等整轮跑完再发现引错条，
// 用户早读进去了。缓冲可能成形的条号，验证通过才放行。
//
// ── 放行集（设计稿 §4.3 逐字）──
//   本轮 `state.retrieved` 的 statute_quotes `(law, article)`
//   ∪ 核心条映射命中且**已取到原文**的条
// 第二项是第一项的**子集**：`coreArticleKeys` 的候选池就是 retrieved 的 statute_quotes，
// 而 S3b 定向注入的核心条卡本身也进了 `state.retrieved`。
// 这不是巧合、也不该靠巧合——它是 ⑥→⑧ 那条交互用例钉住的不变量：
// **⑧ 能补原文的每一条，⑥ 都必须放行**，否则 ⑧ 会去给一个刚被标成【条号待核验】的
// 位置补原文，两道闸在同一处各说各的。判据见 gate-chain.test.ts「⑥⑧ 交互」。

import {
  ARTICLE_PATTERN,
  ASYM_QUOTES,
  ASYM_QUOTE_CAP,
  articleKey,
  normalizeArticle,
  normLaw,
  authoredCitationSpans,
  citationFormOf,
  isStatuteCitationForm,
  type CitationForm,
} from './citation-block';
import {
  SUGGEST_CHECK_STATUTE,
  SUGGEST_FETCH_CURRENT,
  SUPERSEDED_STATUTE,
  UNVERIFIED_STATUTE,
} from './gate-marks';
import type { KnowledgePack } from './retrieval';

/**
 * 验不过的条号后面缀这个。**不删条号**——用户要看得见这里本来引的是哪一条，好自己去查。
 * 字面住在 gate-marks.ts（正文标记 / 提示行 / 一键回复三处同源，见那里的文件头）。
 */
export { UNVERIFIED_STATUTE };

/**
 * 登记簿 status ≠ 现行的条（设计稿 §7.3）。与【条号待核验】分开，因为**两者的出路不同**：
 * 待核验是"我们没取到原文"（用户可以点开来源卡/让我们查），
 * 已修正是"这一条我们取到了、但它已经不是现行文本了"（用户要的是新版，不是这一条）。
 */
export { SUPERSEDED_STATUTE };

/** 登记簿里"这条源还作数"的那个取值。其余取值一律按已修正处置。 */
const STATUS_CURRENT = '现行';

/** 缓冲上限：`《中华人民共和国某某某某法》第一百二十三条第三项` 约 28 字，48 给足余量。 */
const MAX_PENDING = 48;

/**
 * 这处引用**之前**的上文（本行行首到它为止），喂给 `isStatuteCitationForm` 判载体。
 *
 * 【三处调用必须给同一份上文】流上的 `sanitize` 用的是 `this.lineSoFar`
 *（当前行已走过的字，跨 chunk 累积、遇换行清空）——本函数就是它的整段等价物。
 * 两边给的上文一旦不同，形态判据在同一处引用上会给出两个答案：闸在流上按
 *「这是合同条款」放行，自检按「这是法条」报漏网，gate_report 同时说「闸没标」和「闸漏了」。
 * **回看多远由 `isStatuteCitationForm` 一处定**（它自己截末 N 字），这里只负责不跨行。
 */
function lineBefore(text: string, at: number): string {
  return text.slice(text.lastIndexOf('\n', at) + 1, at);
}

/**
 * 可能正在成形的条号尾巴。四种形态各扣一段——**少一种就漏一类**：
 *   ① `《某某某某…`      书名号还没闭合；
 *   ② `《某某某某法》`    法名刚闭合，条号可能在下一片里（**这一条最容易漏**：
 *      法名本身是完整的，不扣住就会把「《X法》」与「第 N 条」切成两片，
 *      两片各自都不匹配整条正则，于是**整个引用凭空躲过闸**）；
 *   ③ `…第四十六`        条号数字正在写；
 *   ④ `…第四十六条第二`  条后还可能跟款/项。
 */
const PARTIAL_TAIL = new RegExp(
  [
    '《[^》\\n]{0,30}$',
    '《[^》\\n]{2,30}》\\s*$',
    '(?:《[^》\\n]{2,30}》\\s*)?第[\\s一二三四五六七八九十百零〇0-9]{0,8}$',
    '(?:《[^》\\n]{2,30}》\\s*)?第\\s*[一二三四五六七八九十百零〇0-9]{1,6}\\s*条(?:\\s*第[\\s一二三四五六七八九十0-9]{0,4})?$',
  ].join('|'),
);

/**
 * 自家注入块格式的**打头行**：`第二十七条　正文…` / `> 《某某某某法》第八十七条　…`。
 * 与 citation-block 的 `SELF_LABELED` 同形，只是这里判的是「行走到这个全角空格为止」，
 * 因为流上没有整行可看。命中即：**该条本身已经判过，后面那段正文是原文，整段免检**。
 */
const SELF_LABELED_LINE = /^\s*>?\s*(?:《[^》]{2,40}》)?\s*第[一二三四五六七八九十百零〇0-9]+条　$/;

/** 从一处引用串里拆出法名（没写就是空串）与归一后的条号。两侧共用同一个拆法。 */
export function splitCitation(raw: string): { law: string; article: string } {
  const flat = raw.replace(/\s+/g, '');
  const law = /《([^》]{2,40})》/.exec(flat)?.[1] ?? '';
  return { law: normLaw(law), article: normalizeArticle(flat.replace(/《[^》]{2,40}》/, '')) };
}

export type StatuteVerdict = 'allowed' | 'unverified' | 'superseded';

export interface StatuteViolation {
  /** 模型写出来的原串 */
  cited: string;
  /** 正文 / 某份文书 */
  where: string;
  /** 为什么不放行 */
  verdict: Exclude<StatuteVerdict, 'allowed'>;
}

/**
 * 开引号 → 与它配对的那个闭引号。**与整段扫描共用 citation-block 的那张表**
 *（`ASYM_QUOTES`），上限（`ASYM_QUOTE_CAP`）同样从那边取：
 * 两处各写一份的形态是同一件事有两个真源，改一处忘一处即两边分叉，
 * 而分叉的表现是"闸标了、自检说没漏"——查起来要先怀疑闸，最后发现是两张表不一样。
 *
 * 上限的意思在流上是：走了这么远还没等到配对的闭引号，就当它没闭合、把免检态收回来。
 * **不设上限的形态是**：模型漏打一个 `」`，从那个字起这一轮的闸全程关闭，
 * 而 gate_report 会诚实地报「候选 0 处、动手 0 处」。
 */
const ASYM_CLOSE_OF = new Map(ASYM_QUOTES.map(([open, close]) => [open, close]));

/**
 * 条号闸门。allowed 集合随本轮检索到的 pack 增长——模型先检索再引用是正常顺序。
 */
export class StatuteGuard {
  /** `法名|第N条` → 这条源的登记簿状态（`undefined` = 卡里没带，见 retrieval.ts 三态） */
  private readonly keyed = new Map<string, string | undefined>();
  /** 只按条号索引，供**没写法名**的引用比对（与 isCoreBlock 同一套「两种键都比一遍」口径） */
  private readonly byArticle = new Map<string, string | undefined>();
  /** 本轮见过多少处 agent 自己写下的**正文**条号引用（gate_report 的分母） */
  private seenCount = 0;
  /**
   * 形态上判不了、按缺口声明放过去的处数——**两个洞分开数**（2026-09-08 第三轮复审 minor）。
   *
   * 【为什么不能合成一个数】合成的形态是：报表上只看得出"洞变大了"，看不出该去动哪一条。
   * 载体排除涨了要动的是 `NON_STATUTE_CARRIER` 那张词表（多了一种用户文件在被当成法条，
   * 或者反过来法名被当成载体）；序数量词涨了要重看的是 `ORDINAL_MAX` 那条口径。
   * 两条的处置方向不同，而"洞有多大必须看得见"这句话的落点恰恰是**看得见该去哪儿看**。
   */
  private ambiguousCarrierCount = 0;
  private ambiguousOrdinalCount = 0;
  private pending = '';
  private readonly violations: StatuteViolation[] = [];
  /**
   * **文书通道**的违规，与正文分开存。
   *
   * 【为什么必须分开】(2026-09-08 修) 合在一起的形态有两处，都会说假话：
   *   · 轮末那条 notice 对用户说「已标注【条号待核验】」——而文书通道是**拒收**，
   *     正文里一个标记都没有；模型下一轮改对了，用户还收到一条说他"已被标注"的通知。
   *   · 替换率把拒收算进分子分母：一份文书引错 1 处、正文 1 处引用，替换率报 50%，
   *     成绩单点名"闸误伤、去查闸的判据"——而闸这一轮做的恰恰是它该做的事。
   */
  private readonly docViolations: StatuteViolation[] = [];
  /** 文书通道看过多少处引用（与正文分账，不进替换率） */
  private docSeenCount = 0;

  // ── 流上的免检态。跨 chunk 保持，因为引号和引用块都可能横跨好几片 ──
  /**
   * 当前**成对非对称引号**（「」『』“”）没闭合时，等着的那个闭引号；`null` = 不在引号里。
   * **跨行保持**——与 citation-block 的 `asymQuoteSpans` 同口径：⑧ 内联补进来的原文
   * 有一半以上是多行的，按行清空免检态就会在原文第 2 行起对着立法者的交叉引用开火。
   *
   * 【为什么存的是"等哪个闭引号"而不是一个布尔（2026-09-08 复审 minor）】
   * 布尔的形态是**任何一种闭引号都能关掉免检**，而整段扫描那边是按同一对配对、
   * 跨过内层的异类引号。真库 318 条原文里有 4 条自带弯引号，模型以「」逐字转引它们时，
   * 内层那个 `”` 会把布尔关掉 → 引文后半截里立法者的交叉引用被标【条号待核验】，
   * 计进 seen 与替换率，而整段自检说一处没漏（它按同对配对，认为整句都在引号里）。
   * 存闭引号本身，两边的配对规则就是同一条。
   */
  private asymClose: string | null = null;
  /** 非对称引号已经开着走了多少字。超 `ASYM_QUOTE_CAP` 即认定它没闭合，收回免检态 */
  private asymRun = 0;
  /** 正处在成对**对称**引号（`"`）里。对称引号开闭同形，只能按行数奇偶，故不跨行 */
  private inQuote = false;
  /** 当前这一行整行免检：markdown 引用块（`> …`）或自家注入块格式（`第N条　正文…`） */
  private lineExempt = false;
  /** 当前行已经走过的字（跨 chunk 累积）。判"行首"与"自家格式打头"都要看它 */
  private lineSoFar = '';

  /**
   * 把这些卡里的 statute_quotes 并入放行集。**只收带逐字原文的条**：
   * 一个只有条号、没有 text 的条目证明不了"我们手上有这条"，收了它等于凭条号放行条号。
   */
  allowFrom(packs: Pick<KnowledgePack, 'facts'>[]): void {
    for (const p of packs) {
      for (const q of p.facts?.statute_quotes ?? []) {
        if (!q?.law || !q?.article || !q?.text?.trim()) continue;
        const key = articleKey(q.law, q.article);
        // 同一条被多张卡收录时，**现行的那一张说了算**：一张卡标已修正、另一张标现行，
        // 说明我们手上有新版原文，此时把引用打成【已修正】是拿旧卡去否定新卡。
        if (!this.keyed.has(key) || this.keyed.get(key) !== STATUS_CURRENT) this.keyed.set(key, q.source_status);
        const bare = normalizeArticle(q.article);
        if (!this.byArticle.has(bare) || this.byArticle.get(bare) !== STATUS_CURRENT) this.byArticle.set(bare, q.source_status);
      }
    }
  }

  /** 放行集里的全部键（`法名|第N条`）。gate_report 与判据侧的漏网自检读它。 */
  allowedKeys(): string[] {
    return [...this.keyed.keys()];
  }

  /** 本轮**正文**看过多少处引用（替换率的分母；文书通道不在此列） */
  get seen(): number {
    return this.seenCount;
  }

  /** 本轮在**正文**里标记的全部违规（供 notice 与日志；空数组＝干净） */
  get found(): readonly StatuteViolation[] {
    return this.violations;
  }

  /** 本轮在**文书通道**拒收的违规。它们不曾出现在用户面，故不进正文 notice 与替换率 */
  get docFound(): readonly StatuteViolation[] {
    return this.docViolations;
  }

  /** 文书通道看过多少处引用（单列，供 gate_report 记账） */
  get docSeen(): number {
    return this.docSeenCount;
  }

  /**
   * 形态上分不清条号与序数量词、按缺口声明放过去的处数。
   * **单列而不是并进 seen**：并进去就变成了"看过并放行"，与"我们没敢判"是两件事，
   * 而后者是一个需要有人盯着的缺口（见 `isStatuteCitationForm`）。
   */
  get ambiguous(): number {
    return this.ambiguousCarrierCount + this.ambiguousOrdinalCount;
  }

  /** 其中：上文是合同/手册/制度这类**载体**、按载体排除放过去的处数 */
  get ambiguousCarrier(): number {
    return this.ambiguousCarrierCount;
  }

  /** 其中：裸条号 ≤ `ORDINAL_MAX`、分不清「第三条」是条号还是量词而放过去的处数 */
  get ambiguousOrdinal(): number {
    return this.ambiguousOrdinalCount;
  }

  /**
   * 记一处"没敢判"。**入口只有这一个**：流上、文书通道两条路都从这里过，
   * 各自 `+= 1` 的形态是加了第三条通道那天漏掉一处，而漏掉的表现是报表上少一个数、不报错。
   */
  private tallyAmbiguous(form: CitationForm): void {
    if (form === '载体排除') this.ambiguousCarrierCount += 1;
    else if (form === '序数量词') this.ambiguousOrdinalCount += 1;
  }

  /** 登记簿状态未接上的条数（放行集里 `source_status` 为 undefined 的） */
  get sourceStatusUnknown(): number {
    return [...this.keyed.values()].filter((s) => s === undefined).length;
  }

  /**
   * 这处引用放不放行。
   *
   * 【写了法名 → 按 `法名|条号` 精确比】这正是「把 §46 讲成 §47」要拦的那一刀：
   * 条号本身在库里、法名也在库里，但**这一对**不在，就是张冠李戴。
   *
   * 【没写法名 → 只按条号比】裸「第 46 条」在正文里极常见（前文点过法名、后文回指）。
   * 要求它带法名等于把 G4「给少了」的账算到 G1「编造」头上，且会把 ⑧ 的
   * `k.endsWith('|第N条')` 那套匹配口径劈成两半——两道闸对同一处引用给出相反判断。
   */
  verdict(raw: string): StatuteVerdict {
    const { law, article } = splitCitation(raw);
    const table = law ? this.keyed : this.byArticle;
    const probe = law ? articleKey(law, article) : article;
    if (!table.has(probe)) return 'unverified';
    const status = table.get(probe);
    // 三态：`undefined` 按现行处理（登记簿未接上，见 retrieval.ts 的注释）
    if (status === undefined || status === STATUS_CURRENT) return 'allowed';
    return 'superseded';
  }

  isSupported(raw: string): boolean {
    return this.verdict(raw) === 'allowed';
  }

  /**
   * 检查一整段文本（**文书通道**）。返回不放行的引用列表，空数组即通过。
   * 与案号闸同一条纪律：**不改写内容**——文书是要落库、要递交的东西，
   * 该由模型改正后重写，而不是我们在一份要发出去的文件里塞占位符。
   *
   * 【已修正的源在文书里是拒收，不是标记】(设计稿 §7.3「禁止进文书」)
   * 正文里标一下用户还能自己判断；文书递出去之后，标记就跟着材料一起交到了对面手里。
   */
  check(text: string, where: string): StatuteViolation[] {
    const bad: StatuteViolation[] = [];
    for (const span of authoredCitationSpans(text)) {
      const form = citationFormOf(span.raw, lineBefore(text, span.at));
      if (form !== '法条') {
        this.tallyAmbiguous(form);
        continue;
      }
      this.docSeenCount += 1;
      const v = this.verdict(span.raw);
      if (v === 'allowed') continue;
      const hit = { cited: span.raw, where, verdict: v };
      bad.push(hit);
      this.docViolations.push(hit);
    }
    return bad;
  }

  /**
   * 流式过滤：喂一片增量，返回可安全下发的文本。
   * 可能正在成形的条号会被扣住，等它闭合（或确定不是条号）再决定放行还是标记。
   */
  push(chunk: string): string {
    this.pending += chunk;
    const m = PARTIAL_TAIL.exec(this.pending);
    let safeEnd = this.pending.length;
    if (m && this.pending.length - m.index <= MAX_PENDING) safeEnd = m.index;

    const out = this.sanitize(this.pending.slice(0, safeEnd));
    this.pending = this.pending.slice(safeEnd);
    return out;
  }

  /** 流末冲刷：扣住的尾巴此时不可能再闭合了，按现状判定后交出 */
  flush(): string {
    const out = this.sanitize(this.pending);
    this.pending = '';
    return out;
  }

  /**
   * 闸跑完之后的**漏网自检**：用户面还剩几处不在放行集、也没带标记的引用。
   *
   * 【为什么闸要自己数一遍自己的输出】结构上它应恒为 0。恒为 0 的量看起来没用，
   * 直到它不是 0 的那一天——而那一天如果没人在数，我们只会看到"替换率很低，闸很干净"。
   * 这是「剥除率与漏网率并列报告」里的第二个数，缺了它第一个数读不出意思。
   *
   * 取材面与 ⑧ 共用 `authoredCitationSpans`：法条原文自己的交叉引用不算 agent 写的引用，
   * 否则 ⑧ 刚补进来的原文会被记成 ⑥ 的失守。
   */
  leakedIn(text: string): string[] {
    return authoredCitationSpans(text)
      .filter((span) => {
        // 形态上分不清条号与量词的那些，⑥ 在流上就没判（见 isStatuteCitationForm）。
        // 漏网自检必须用**同一条**取材规则，否则它会把闸明说不判的东西记成闸漏了。
        // **上文也要一起给**：形态判据要看条号前面那几个字（载体是不是一份合同/手册），
        // 自检这边不给上文的形态是——流上放行了、自检说漏了，而两边比的是同一处引用。
        if (!isStatuteCitationForm(span.raw, lineBefore(text, span.at))) return false;
        const after = text.slice(span.end, span.end + UNVERIFIED_STATUTE.length + SUPERSEDED_STATUTE.length);
        if (after.startsWith(UNVERIFIED_STATUTE) || after.startsWith(SUPERSEDED_STATUTE)) return false;
        return !this.isSupported(span.raw);
      })
      .map((span) => span.raw);
  }

  /**
   * 逐字符走一遍，只替换**免检态之外**的引用。
   *
   * 【为什么必须跳过引号内与引用块】法条原文里到处是交叉引用：《实施条例》第 27 条的
   * 正文写着「依照某某某某法第四十七条规定」。那是**立法者写的**，不是 agent 写的，
   * 它在不在我们的放行集里与本轮引用是否可靠毫无关系。不跳过的形态是：
   * 每补一条原文就顺手在原文内部制造一处【条号待核验】——**闸自己把自己的输出弄脏**，
   * 而替换率会被这类自伤顶穿 2% 预算，读的人还以为是模型在编条号。
   */
  private sanitize(text: string): string {
    if (!text) return text;
    const re = new RegExp(ARTICLE_PATTERN, 'g');
    const marks: { at: number; end: number; raw: string; verdict: StatuteVerdict }[] = [];
    for (const m of text.matchAll(re)) {
      marks.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0], verdict: 'allowed' });
    }

    let out = '';
    let head = 0; // 下一个待判定的匹配（起点游标）
    let tail = 0; // 下一个待收尾的匹配（终点游标）
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        // 整行免检（blockquote / 自家格式）与**对称**引号都不跨行
        //（与 citation-block 的 QUOTED / insideVerbatim 同口径）。
        // **非对称引号刻意不清**：⑧ 内联补进来的原文多数是多行的，按行清空
        // 会在原文第 2 行起对着立法者的交叉引用开火。
        this.lineExempt = false;
        this.inQuote = false;
        this.lineSoFar = '';
      }
      if (this.asymClose) {
        this.asymRun += 1;
        // 走了这么远还没等到配对的闭引号 → 当它没闭合，把免检态收回来（否则闸从此永久关闭）
        if (this.asymRun > ASYM_QUOTE_CAP) {
          this.asymClose = null;
          this.asymRun = 0;
        }
      }

      // 【判定在字符落定之前】此刻的免检态说的是"这个匹配的起点在不在免检区里"
      while (head < marks.length && marks[head].at === i) {
        const mark = marks[head];
        if (this.asymClose || this.inQuote || this.lineExempt) {
          mark.verdict = 'allowed'; // 免检：立法者写的交叉引用，不计分母也不计分子
        } else {
          const form = citationFormOf(mark.raw, this.lineSoFar);
          if (form !== '法条') {
            // 形态上判不了（载体是合同/手册的「第十二条」、序数用法的「第一条建议」）——
            // 明说的缺口，按类分开计数、不判、不计分母。
            // 判它的代价是把一段正确的话弄脏（见 citation-block）。
            mark.verdict = 'allowed';
            this.tallyAmbiguous(form);
          } else {
            this.seenCount += 1;
            mark.verdict = this.verdict(mark.raw);
            if (mark.verdict !== 'allowed') {
              this.violations.push({ cited: mark.raw, where: '正文', verdict: mark.verdict });
            }
          }
        }
        head += 1;
      }

      out += ch;
      if (ch !== '\n') this.lineSoFar += ch;

      // 引号状态在字符落定**之后**翻转：开引号本身不在引号内，闭引号本身还算在里面
      const opens = ASYM_CLOSE_OF.get(ch);
      if (opens) {
        // 已经开着时**不重置计时、也不改等待中的闭引号**：整段扫描那边是跳过区间内的
        // 开引号的（`asymQuoteSpans` 从闭引号之后接着找），两边必须是同一条规则。
        if (!this.asymClose) {
          this.asymClose = opens;
          this.asymRun = 0;
        }
      } else if (this.asymClose && ch === this.asymClose) {
        // **只认配对的那一个**：内层的异类闭引号（引文里的 `”`）关不掉外层的「」
        this.asymClose = null;
        this.asymRun = 0;
      } else if (ch === '"') this.inQuote = !this.inQuote;
      // `>` 打头 = markdown 引用块整行免检
      else if (!this.lineExempt && ch === '>' && /^\s*>$/.test(this.lineSoFar)) this.lineExempt = true;
      // `第N条　` 打头 = 自家注入块格式，该条本身已判过，后面的正文整段免检
      else if (ch === '　' && SELF_LABELED_LINE.test(this.lineSoFar)) this.lineExempt = true;

      // 收尾：判定不放行的，就地缀上标记（**不删条号**，用户要看得见引的是哪一条）
      while (tail < marks.length && marks[tail].end === i + 1) {
        const done = marks[tail];
        if (done.verdict === 'superseded') out += SUPERSEDED_STATUTE;
        else if (done.verdict === 'unverified') out += UNVERIFIED_STATUTE;
        tail += 1;
      }
    }
    return out;
  }
}

/**
 * 用户侧 notice 文案。**禁令必配出路**（设计稿 §7.7）：
 * 每一处标记都要告诉用户"接下来他能做什么"，否则这条标记只是在告诉他"这儿有问题"，
 * 而他既不知道真条号是哪条、也不知道找谁去核。
 */
export function statuteNoticeMessage(violations: readonly StatuteViolation[]): string {
  const unverified = [...new Set(violations.filter((v) => v.verdict === 'unverified').map((v) => v.cited))];
  const superseded = [...new Set(violations.filter((v) => v.verdict === 'superseded').map((v) => v.cited))];
  const lines: string[] = [];
  if (unverified.length) {
    lines.push(
      `本轮有 ${unverified.length} 处条号不在这一轮取到的原文里：${unverified.join('、')}，已标注${UNVERIFIED_STATUTE}。` +
        `出路：点开回复里的来源卡看我们手上有哪几条，或直接回我一句「${SUGGEST_CHECK_STATUTE}」，我去把原文取回来再引给你。`,
    );
  }
  if (superseded.length) {
    lines.push(
      `本轮有 ${superseded.length} 处条号的来源已不是现行文本：${superseded.join('、')}，已标注${SUPERSEDED_STATUTE}。` +
        `出路：这一条不要再往文书里写；回我一句「${SUGGEST_FETCH_CURRENT}」，我按登记簿里的新版原文重新引。`,
    );
  }
  return lines.join('\n');
}

/**
 * 一键回复 chip 的文本：**用户点一下就原样发出去的那句话**，与上面出路句里引的那句逐字相同。
 *
 * 【为什么由服务端给，而不是前端按 code 写死一句】两种判定的出路完全不同
 *（没取到原文 → 去取；已不是现行文本 → 换新版），前端按 code 写死就只能给其中一句，
 * 而它挑中的那句在另一半场景里会把用户指到错的地方。
 *
 * 两种判定同时命中时给「取原文」那一句：它是能当场推进的那条，
 * 而「取新版」要等登记簿里真有新版。
 */
export function statuteNoticeSuggest(violations: readonly StatuteViolation[]): string | undefined {
  if (violations.some((v) => v.verdict === 'unverified')) return SUGGEST_CHECK_STATUTE;
  if (violations.some((v) => v.verdict === 'superseded')) return SUGGEST_FETCH_CURRENT;
  return undefined;
}

/** 回喂给模型的改正指令（文书通道用）。说清违规的是哪一条、为什么不行、该怎么办。 */
export function statuteCorrectionDirective(bad: readonly StatuteViolation[], title: string): string {
  const unverified = bad.filter((v) => v.verdict === 'unverified').map((v) => v.cited);
  const superseded = bad.filter((v) => v.verdict === 'superseded').map((v) => v.cited);
  return [
    `文书《${title}》里这些条号本轮拿不出原文，已拒绝落库：`,
    unverified.length ? `· 本轮检索结果里没有它们的逐字原文：${unverified.join('、')}` : '',
    superseded.length ? `· 来源登记簿标注这几条已不是现行文本：${superseded.join('、')}` : '',
    '文书是要递出去、要归档的，条号引错一处，整份材料的可信度就没了。',
    '请先用 knowledge_search 取到该条原文再引；取不到就不要给条号，',
    '改写成「这一点我需要核实依据」，或改引本轮确实取到原文的那几条。',
  ]
    .filter(Boolean)
    .join('\n');
}
