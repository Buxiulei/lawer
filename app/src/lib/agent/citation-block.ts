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
 * 本轮的**核心依据条**（`法名|条号` 集合），**由结构化事实判定，不让模型自己勾**。
 *
 * 【为什么必须结构化判定】（manager 2026-08-23 落地约束）
 * 「哪几条是核心」如果交给模型自己判断，等于把分层的判定权交还给我们本想约束的那一方——
 * 它会把"我打算详细讲的"标成核心，而不是"用户拿去主张权利要用的"。
 * 所以核心条只从**已经落库的结构化事实**里取：
 *   ① `claims.basis`——calc_calc 落库时写的法条串（**这是钱的依据**，用户会拿它去主张）；
 *   ② 行动卡 detail 里出现的条号（行动卡是「现在做什么」，其依据必然是核心）；
 *   ③ 生效中的期限推算依据（`deadlines.derived_from`）。
 *
 * 【它解决的是什么】S03#2：同一回复对《调解仲裁法》§27 引了全文、对《实施条例》§27 只给条号，
 * 而后者恰恰是**结论句同句**的那条（补偿基数）。模型不是不会引，是**不知道哪条值得引全**。
 * 与其加一条"每条都必须带原文"的粗规则（会盖掉核心/辅助分层与 pending 三分支），
 * 不如**把"哪条是核心"从模型的判断变成注入的事实**——降低正确行为的成本，而不是提高错误行为的代价。
 */
export function coreArticleKeys(input: {
  claims?: { basis: string | null }[];
  openActions?: { detail: string | null }[];
  deadlines?: { derived_from: string | null }[];
}): Set<string> {
  const out = new Set<string>();
  const collect = (text: string | null | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(ARTICLE)) {
      const raw = m[0].replace(/\s+/g, '');
      const law = /《([^》]{2,40})》/.exec(raw)?.[1] ?? '';
      const art = raw.replace(/《[^》]{2,40}》/, '');
      out.add(`${law.replace(/^中华人民共和国/, '')}|${art}`);
    }
  };
  for (const c of input.claims ?? []) collect(c.basis);
  for (const a of input.openActions ?? []) collect(a.detail);
  for (const d of input.deadlines ?? []) collect(d.derived_from);
  return out;
}

/** 该引用块讲的是不是核心条 */
function isCoreBlock(law: string, article: string, core: Set<string>): boolean {
  const norm = law.replace(/[《》\s]/g, '').replace(/^中华人民共和国/, '');
  const art = article.replace(/\s+/g, '');
  return core.has(`${norm}|${art}`) || core.has(`|${art}`);
}

export function packCitationGuide(pack: KnowledgePack, core: Set<string> = new Set()): string {
  const quotes = pack.facts?.statute_quotes ?? [];
  const coreHere = quotes.filter((q) => q?.law && q?.article && isCoreBlock(q.law, q.article, core));
  const blocks = [...statuteBlocks(pack), ...valueBlocks(pack), ...precedentBlocks(pack)];
  if (blocks.length === 0) return citationTemplate(pack);
  const head = ['【本卡可引用内容已替你拼好，照抄即可（不要改写、不要缩写、不要只留编号）】'];
  if (coreHere.length > 0) {
    head.push(
      '',
      `⭐ **本轮核心依据条**（档案里的诉求金额/行动卡/期限直接依赖它们）：` +
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

function hasVerbatimNear(near: string): boolean {
  if (BLOCKQUOTE.test(near)) return true;
  if (OWN_QUOTE_FORMAT.test(near)) return true;
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
  const cardGrams = grams(cards.map((c) => `${c.title}\n${c.body}\n${JSON.stringify(c.facts ?? {})}`).join('\n'));
  const factGrams = grams(userFacts);
  const dirty = new Set<string>();
  for (const s of text.split(/[。！？\n]/)) {
    if (!s.trim() || !PRECEDENT_MARK.test(s)) continue;
    for (const g of grams(s)) if (factGrams.has(g) && !cardGrams.has(g)) dirty.add(g);
  }
  return [...dirty];
}

export function bareArticleCitations(text: string, windowSize = 60): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ARTICLE)) {
    const at = m.index ?? 0;
    // 法条原文内部的交叉引用不算 agent 的光秃引用（立法者写的，不是它写的）
    if (insideVerbatim(text, at)) continue;
    const near = text.slice(Math.max(0, at - windowSize), at + m[0].length + windowSize);
    if (!hasVerbatimNear(near)) out.push(m[0].replace(/\s+/g, ''));
  }
  return out;
}

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
 * 引号内容在**本轮注入块**里没有支撑的那些（= 伪逐字引用）。
 *
 * 【为什么必须是「本轮注入」而不是「整个知识库」】S14 那轮根本没检索到 534 卡。
 * 拿全库比对会让「这轮没查却背出来」通过——而**背出来的那次恰恰最危险**：
 * 它没有经过检索，也就没有经过任何新鲜度与版本校验（子项从 (1) 记成 (4) 正是记忆复述的形态）。
 */
export function unsupportedVerbatimQuotes(text: string, injected: KnowledgePack[]): string[] {
  const corpus = normQuote(injected.map((p) => `${p.title}\n${p.body}\n${JSON.stringify(p.facts ?? {})}`).join('\n'));
  return quotedStatuteSpans(text)
    .filter(({ quote }) => !corpus.includes(normQuote(quote)))
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
export function stripUnsupportedQuotes(text: string, injected: KnowledgePack[]): { text: string; stripped: string[] } {
  const bad = unsupportedVerbatimQuotes(text, injected);
  if (bad.length === 0) return { text, stripped: [] };
  let out = text;
  for (const q of bad) {
    // 连同包裹它的引号一起替换，避免留下半个引号
    out = out.replace(new RegExp(`[「『"“]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[」』"”]`, 'g'), VERBATIM_UNVERIFIED);
  }
  return { text: out, stripped: bad };
}
