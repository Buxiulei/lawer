// app/src/app/__tests__/lawyer-referral-guard.test.ts
// **产品面与 charter 里的「律师」只允许出现在三个位置**（主理人 2026-09-07 裁决：
// 能我们的智能体完成的都我们来做；实在绕不过去、必须要律师签字背书的，才建议去找律师；
// 不要向用户推卸责任）：
//   ① 否定式免责与禁令  —「不构成律师意见」「不劝找律师」「禁止用『建议咨询律师』收尾」；
//   ② 闭合清单的渲染    —「法律上必须由执业律师做」那一段（lib/agent/lawyer-mandatory.ts，
//                        条目来自 DomainPack.lawyerMandatory，每条带法条锚点）；
//   ③ 法条 / 判例原文    —《中华人民共和国律师法》那一类逐字引用。
// 其余即红。
//
// 【它与 lawyer-self-claim-guard 是两道不同的闸，别合并】那一道问的是"**我们**是不是
// 冒充了律师"（律师法 §13 的自称），这一道问的是"我们是不是把用户**推给了**律师"。
// 同一句话可以过了前一道而被这一道拦下：「到仲裁阶段可以找律师」不是自称，
// 但它正是裁决要禁的那种收尾。合并的形态是：为了让一道判据变绿而放宽另一道的口径。
//
// 【为什么按文件扫，而不是靠复审】"这个建议你咨询一下律师"是**最省力的收尾方式**，
// 顺手就写出来了，读起来还很负责任；它渲染不报错、测试也不红。复审时有没有人注意到，
// 不能是这条红线唯一的依靠——**独立写 N 次就会松口其中某一次**。
//
// ============================ 判定面（2026-09-07 复审后收紧） ============================
// 【第一版错在哪】第一版按句号切句、只问"这一句里出现『律师』的位置往前 24 个字里
// 有没有任何一个否定字"，另外整句里只要出现「律师法／民事诉讼法」就整句放行。于是
//   「这不是小事，拿不准的时候建议尽快咨询律师」——托它的"不是"根本不在托它；
//   「金额较大的，可以找律所代理（依据：律师法第十三条）」——法条名把整句白名单了；
// 这两句原样通过。**否定词与法条名都是句子里最容易顺手出现的东西**，靠"附近有没有"
// 判定，等于给每一句违规话留了一个几乎必然满足的出口。
//
// 【现在怎么判】每一次「律师」出现，都必须落在下面某一个**具体的构造**里，
// 而不是"附近有点像"：
//   S1 逐字钉住的例外（PINNED）——出现位置必须落在那句话内部；
//   S2 否定式搭配（NEGATION）——否定词必须与它同在**一个分句**内，且在它前 12 字以内。
//      分句按「，；！？」切：跨了逗号的否定词托不住后半句，这正是第一版漏掉的形态；
//   S3 闭合清单标记（MANDATORY）——「必须/只能由执业律师」在同一分句里；
//   S4 法条引用——出现位置落在《》书名号内部，或落在**逐字引文那一段里**：
//      「第X条：」之后到分句末（这一段就是被抄下来的条文），或分句已报出《…》时的引号内部。
//      判的是**位置**，不是"这一分句里有没有引文"：后者把整分句白名单了，
//      于是「可以找律所代理（依据《律师法》第十三条）」原样通过（2026-09-07 第二次复审实测）；
//   S5 被引用的那句禁语——出现位置落在引号内部，且整句带禁令语气。
//      产品面里"禁止说『建议咨询律师』"就是这个形态：被禁的原话必须能写出来；
//   S6 顿号并列继承——「指向律师、律所」里的后一项，跟着前一项走（间隔只许是顿号一类）。
// 六条都不成立即红。取不准时偏向报警：漏判没有任何人会发现，误判会有人来吵。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** app/src */
const SRC_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** 提到律师的两种写法。「法律顾问」「专业人士」那几种由 C04 判据 G2 在行为面拦（LAWYER_NAG）。 */
const MENTION = /律师|律所/g;

/**
 * S2 的判定窗：否定词必须落在「律师」前这么多个字以内，且不许跨分句。
 * 判定的那一小段**含「律师」本身**——「没有律师」这类搭配的否定字就贴在它前面，
 * 切在它前面一格的话这条搭配永远匹配不上（第一版就是这么写的，靠一个通用的"没有"蒙混过去）。
 */
const WINDOW = 12;

/**
 * S2 否定式与禁令。**收的是与"律师"搭在一起的那几个说法**，不是"任何否定字"：
 * 第一版把「不是／没有／别／不能」这类通用否定字也算进来，于是"这不是小事，……建议找律师"
 * 只要不加句号就整句放行。这里只留搭配（不构成律师意见 / 不自称律师 / 请不起律师 /
 * 不劝找律师 / 不得指向律师 / 不用「建议咨询律师」收尾 / 别找律师），
 * 代价是将来写出新的正当说法时这道闸会红——那时**把它加进来并写下理由**，
 * 而不是把窗口调宽：窗口一宽就没人知道它还在拦什么。
 *
 * 【2026-09-07 合入 P5-C3（协议正文页）时补的三条，各自的理由】三处都是**否定式的
 * 身份边界声明**，逐字来自协议正本或它引的法条，不是新写出来的话：
 *  · 不是律师     ——「我们不是律师事务所」（正本一.4 那句一句话说明的收尾）；
 *  · 不以律师     ——「不以律师名义提供法律服务」（正本二.1，也是《律师法》§13 的用语）。
 *    只写到「律师」为止：判定窗**在「律师」那两个字处收尾**（见 WINDOW 抬头），
 *    把"名义"也写进来的话这条搭配永远匹配不上，而它看起来像已经加过了。
 *  · 没有取得律师 ——《律师法》第十三条原文开头「没有取得律师执业证书的人员」。
 *    它本就是否定式，只是否定词与「律师」之间隔了「取得」两字，`没有律师` 那一条够不着。
 * 三条都是**与"律师"直接搭在一起的固定说法**，不是通用否定字：把用户支出去的那种句子
 * （"这个建议你咨询一下律师"）一条也满足不了。
 */
const NEGATION =
  /不构成|不自称|不冒充|不声称|请不起|没有律师|不是律师|不以律师|没有取得律师|不劝|不得|不许|不用|不写|禁止|别找|别去找/;

/**
 * S3 闭合清单的渲染。判定按**这几个标记**，不按文件豁免：整份文件豁免的形态是，
 * 有人往那个文件里加一句"拿不准就建议用户找律师"，而它是白名单文件，闸不响。
 *
 * 【「执业」两字可有可无】协议正本二.3 的原话是「只有法律规定**必须由律师办理**的事项」。
 * 只认带"执业"的写法，等于逼着页面为了让判据变绿而偏离正本——那是把尺子架在被量的
 * 东西上面。构造是「必须／只能由（执业）律师」这一句本身，"执业"是修饰词不是构造。
 */
const MANDATORY = /必须由(?:执业)?律师|只能由(?:执业)?律师|lawyerMandatory/;

/**
 * S4 的第二半：**逐字引文从哪里开始**。
 *
 * 【为什么钉的是「第X条：」这个冒号，而不是"分句里有条号"】第二版写成
 * `titles.length > 0 && STATUTE_ARTICLE.test(clause)`——即"这一分句里既有《…》又有条号
 * 就整分句放行"。于是「可以找律所代理（依据《律师法》第十三条）」原样通过：
 * 括号里那半句是真引文，被它白名单掉的却是括号外面那半句。
 * **法名与条号都是最容易顺手带上的东西**，靠"分句里有没有"判定，
 * 等于给每一句违规话留了一个加个括号就能满足的出口。
 * 冒号之后那一段才是被抄下来的条文本身，位置是可数的。
 */
const ARTICLE_LEAD = /第[一二三四五六七八九十百千零〇\d]+条[：:]/g;


/**
 * S5 的语气条件：引用一句被禁的话时，整句必须带禁令语气。
 * 它比 NEGATION 宽（一个"不"就够），因为**加引号这件事本身**已经是很强的约束：
 * 真要把人支出去的人不会给那句话打上引号再禁掉它。
 */
const PROHIBIT = /不|禁止|勿|别|绝/;

/**
 * S1 两处**逐字钉住**的例外，各配一条理由。
 *
 * 【为什么它们不能靠上面几条通过，也不该改写】「以执业律师的严谨方式工作」是
 * 身份边界那句话的前半截（后半截就是"但不自称律师"）——它讲的是**我们自己的标准**，
 * 既不是免责、也不是把人支出去。「律师 agent」是这份准则在文档里的名字（charter 的抬头），
 * 它随 charter 逐字进 system prompt，改它等于改 manager 维护的那份文件。
 * 钉成常量而不是放进上面的正则：例外要能被数清楚，多一条就得有人写下它为什么在这里。
 */
const PINNED = ['以执业律师的严谨方式工作', '律师 agent'];

/** S6 允许继承的间隔：并列项之间只许隔这些字符，且不超过两个。 */
const ENUM_GAP = /^[、/／和或\s]{0,2}$/;

/** 递归收集 .ts/.tsx，跳过 __tests__（判据里出现这些词是它在被验，不是它在说话） */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描面 = 产品面（用户看得见的字）+ 写给模型的那三份纪律文案。
 *
 * 【为什么 lib 那侧只点这几个文件，而不是整个 lib】"律师"这两个字在 lib 里到处都是，
 * 而绝大多数是**内部叙述**（模块头注释、变量名、解释存疑那套机制）。
 * 整个 lib 一起扫的形态是：判据一片红，于是有人给它加一张长长的豁免名单，
 * 而豁免名单一长就没人看得懂它到底还在拦什么。这几个文件是**对外说话的那几份**：
 * 准则、system prompt、无工具模式开场白、闭合清单渲染、闸标记的那几句出路话术。
 *
 * 【2026-09-10 补进 gate-marks.ts，理由】三道出口闸开火之后给用户的那几句话都住在那里
 *（正文标记的悬停解释、提示行的 notice 文案、一键回复 chip）。它们与本闸要拦的东西
 * 正好同型——都是"这一处有问题"之后紧接着的那半句，而**最省力的那半句就是把人支出去**。
 * 不进扫描面的形态是：那几句话每天都在用户眼前，而这道闸从没看过它们。
 */
const SCANNED = [
  ...walk(path.join(SRC_ROOT, 'app')),
  ...walk(path.join(SRC_ROOT, 'components')),
  ...[
    'lib/agent/charter.ts',
    'lib/agent/prompt.ts',
    'lib/agent/lawyer-mandatory.ts',
    'lib/agent/gate-marks.ts',
    'lib/paste/guide.ts',
  ].map((f) => path.join(SRC_ROOT, f)),
];
const rel = (file: string) => path.relative(SRC_ROOT, file);

/** 与 lawyer-self-claim-guard 同一份剥法：注释里讲往事不算对用户说话。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

/** 成对符号围出来的区间（返回的是**里面**那一段的下标区间）。 */
function pairedSpans(clause: string, open: string, close: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const a = clause.indexOf(open, from);
    if (a < 0) break;
    const b = clause.indexOf(close, a + 1);
    if (b < 0) break;
    out.push([a + 1, b]);
    from = b + 1;
  }
  return out;
}

/** 同形引号（英文双引号）按出现顺序两两配对。 */
function sameCharSpans(clause: string, ch: string): Array<[number, number]> {
  const at: number[] = [];
  for (let i = 0; i < clause.length; i++) if (clause[i] === ch) at.push(i);
  const out: Array<[number, number]> = [];
  for (let k = 0; k + 1 < at.length; k += 2) out.push([at[k] + 1, at[k + 1]]);
  return out;
}

/** 书名号区间（S4 的第一半）。 */
function titleSpans(clause: string): Array<[number, number]> {
  return pairedSpans(clause, '《', '》');
}

/**
 * S4 的放行区间：**逐字引文占的那一段**。两种构造，都按位置算：
 *   ① 「第X条：」之后到分句末 —— 冒号后面那一段就是被抄下来的条文；
 *   ② 这一分句已经报出《…》时的引号内部 —— "《律师法》第十三条规定「……」"这一形态。
 * 分句里只出现《…》与条号、而"律师"落在它们外面（"找律所代理（依据《律师法》第十三条）"），
 * 一条都不占，按红处理。
 */
function citationSpans(clause: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of clause.matchAll(ARTICLE_LEAD)) {
    out.push([(m.index ?? 0) + m[0].length, clause.length]);
  }
  if (titleSpans(clause).length > 0) out.push(...quoteSpans(clause));
  return out;
}

/** 引号区间（S5）。 */
function quoteSpans(clause: string): Array<[number, number]> {
  return [
    ...pairedSpans(clause, '「', '」'),
    ...pairedSpans(clause, '『', '』'),
    ...pairedSpans(clause, '“', '”'),
    ...sameCharSpans(clause, '"'),
  ];
}

/** 逐字钉住那几句在本分句里占的区间（S1）。 */
function pinnedSpans(clause: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of PINNED) {
    let from = 0;
    for (;;) {
      const a = clause.indexOf(p, from);
      if (a < 0) break;
      out.push([a, a + p.length]);
      from = a + p.length;
    }
  }
  return out;
}

/**
 * 这段文字里，有哪几次「律师」**没有**被上面六条托住。
 * 返回的是那几次出现所在分句的原文（给人看的，报错里要能照着搜到）。
 */
export function unsanctionedMentions(text: string): string[] {
  const out: string[] = [];
  // 先切句（S5 的"整句带禁令语气"按这一层算），再切分句（S2/S3/S4/S6 按这一层算）
  for (const sentence of text.split(/[。\n]/)) {
    if (!/律师|律所/.test(sentence)) continue;
    const quotedIsCited = PROHIBIT.test(sentence);
    for (const clause of sentence.split(/[，,；;！!？?]/)) {
      const titles = titleSpans(clause);
      const quotes = quoteSpans(clause);
      const pinned = pinnedSpans(clause);
      const citations = citationSpans(clause);
      const hasMandatory = MANDATORY.test(clause);
      let prevEnd = -1;
      let prevOk = false;
      for (const m of clause.matchAll(MENTION)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        const inside = (spans: Array<[number, number]>) => spans.some(([a, b]) => at >= a && end <= b);
        const gap = prevEnd < 0 ? null : clause.slice(prevEnd, at);
        // 显式标 boolean：S6 会回看上一处的判定（prevOk ← ok），不标的话 tsc 认为它在自我引用
        const ok: boolean =
          inside(pinned) ||
          NEGATION.test(clause.slice(Math.max(0, at - WINDOW), end)) ||
          hasMandatory ||
          inside(titles) ||
          inside(citations) ||
          (inside(quotes) && quotedIsCited) ||
          (prevOk && gap !== null && ENUM_GAP.test(gap));
        if (!ok) out.push(clause.replace(/\s+/g, ' ').trim().slice(0, 80));
        prevEnd = end;
        prevOk = ok;
      }
    }
  }
  return out;
}

describe('产品面与 charter 只在三个位置提「律师」（主理人 2026-09-07 裁决）', () => {
  it('全站一处越界的都没有（变异：往 charter 塞一句「建议尽快咨询律师」→ 红）', () => {
    const hits: string[] = [];
    for (const file of SCANNED) {
      for (const frag of unsanctionedMentions(stripComments(fs.readFileSync(file, 'utf-8')))) {
        hits.push(`${rel(file)}：…${frag}…`);
      }
    }
    expect(
      hits,
      `这几处把用户指向了律师：\n  ${hits.join('\n  ')}\n` +
        '缺什么：主理人 2026-09-07 裁决——能我们的智能体完成的都我们来做，' +
        '只有实在绕不过去、必须要律师签字背书的才建议去找律师，不要向用户推卸责任。\n' +
        '为什么缺：「这个建议你咨询一下律师」是最省力的收尾方式，读起来还像尽责，' +
        '而它渲染不报错、别的判据也不红。\n' +
        '怎么办：把这件事**做完**（查依据、算金额、起草、列清单），或者——如果它真的' +
        '法律上只能由执业律师做——把它加进 DomainPack.lawyerMandatory（要带法条锚点），' +
        '由 lib/agent/lawyer-mandatory.ts 那一段统一说出口。' +
        '若确认是一句**正当**说法而被误判，把它的搭配加进本文件 NEGATION 并写下理由，' +
        '不要去调宽 WINDOW。',
    ).toEqual([]);
  });

  it('六条放行构造逐条放行（变异：删掉对应那一条 → 这一行红）', () => {
    // S1 逐字钉住
    expect(unsanctionedMentions('# 律师 agent 行为准则 v1.0')).toEqual([]);
    expect(unsanctionedMentions('以执业律师的严谨方式工作，但不自称律师。')).toEqual([]);
    // S2 否定式免责与禁令
    expect(unsanctionedMentions('这里提供法律信息与行动建议，不构成律师意见、不形成委托代理关系。')).toEqual([]);
    expect(unsanctionedMentions('7. 不劝找律师（§1 闭合清单例外）。')).toEqual([]);
    expect(unsanctionedMentions('你的用户请不起律师，仲裁与诉讼都要自己跑。')).toEqual([]);
    expect(unsanctionedMentions('禁止用「建议咨询律师」这类话收尾。')).toEqual([]);
    // S3 闭合清单的渲染
    expect(unsanctionedMentions('## 只有这几件事法律上必须由执业律师做（本段之外不许把用户支出去）')).toEqual([]);
    // S4 法条原文
    expect(
      unsanctionedMentions('《律师法》第十三条：没有取得律师执业证书的人员，不得以律师名义从事法律服务业务。'),
    ).toEqual([]);
    // S5 被引用的那句禁语
    expect(unsanctionedMentions('不写「以上仅供参考」「建议咨询专业律师」这类话。')).toEqual([]);
    // S6 顿号并列继承
    expect(unsanctionedMentions('清单之外一律不得把用户指向律师、律所或"专业人士"。')).toEqual([]);
  });

  /**
   * 反方向：**这几句必须红**。判据太窄（把违规放过去）比太宽严重得多——
   * 太宽会有人来报虚警，太窄没有任何人会发现。
   */
  it.each([
    '这个问题建议你咨询律师',
    '建议尽快咨询律师，避免超期',
    '到仲裁阶段可以找律师代理，我们把材料整理好交给他',
    '这个还是得找律师看一眼',
    '金额比较大，最好委托一位律师',
    '拿不准的地方请律所出个意见',
  ])('把用户支出去的写法一律红：「%s」', (t) => {
    expect(unsanctionedMentions(t).length).toBeGreaterThan(0);
  });

  /**
   * 【第一版原样漏过的九条，逐条钉住】它们的共同形态是：句子里**碰巧**有一个否定字
   * 或一个法名，而它并不在托这一次出现。复审（2026-09-07）用同一份函数复刻脚本
   * 实测这九条全绿——所以它们不是假想，是这道闸真实的口子。
   */
  it.each([
    // ① 逗号隔开的否定词：托它的"不是/不能/没有/别"根本不在托它
    ['逗号前的否定词', '这不是小事，拿不准的时候建议尽快咨询律师'],
    ['先免责再支人（逗号连接）', '这不构成律师意见，但建议你找律师看看'],
    ['催促式', '别拖了，赶紧去找个律师'],
    ['条件式', '如果没有把握，建议委托律师处理'],
    ['时限式', '不能再等了，请尽快找律师'],
    // ② 不加逗号也一样：否定词管的是另一件事
    ['同一分句里的无关否定', '如果没有把握就建议委托律师处理'],
    ['拿不准三个字里的"不"', '拿不准的时候可以找个律师问问'],
    // ③ 法名当白名单：随口报法名 ≠ 在引条文
    ['随口报法名', '按民事诉讼法你也可以委托律所代理'],
    ['法名加条号但不是引文', '金额较大的，可以找律所代理（依据：律师法第十三条）'],
  ])('第一版漏过的形态现在判红：%s', (_label, t) => {
    expect(unsanctionedMentions(t).length, `这一句仍然被放行了：${t}`).toBeGreaterThan(0);
  });

  /**
   * 【第二版漏过的三条，逐条钉住】第二版把 S4 写成"这一分句里既有《…》又有条号就整分句放行"，
   * 于是**把括号里那半句真引文的白名单，发给了括号外面那半句**。
   * 第二次复审（2026-09-07）给的三条探针在第二版下实测全绿——它们不是假想，
   * 是"加个括号引一条法"这个几乎零成本的出口。
   */
  it.each([
    ['括号里的引文白名单了括号外', '金额较大的可以找律所代理（依据《律师法》第十三条）'],
    ['先报法名再支人（同一分句）', '根据《民事诉讼法》第六十一条你也可以委托律师代理'],
    ['引文当理由用', '《律师法》第十三条摆在那里所以这类事还是得找律师'],
  ])('第二版漏过的形态现在判红：%s', (_label, t) => {
    expect(unsanctionedMentions(t).length, `这一句仍然被放行了：${t}`).toBeGreaterThan(0);
  });

  /**
   * 反方向自证：**真的逐字引条文仍然放行**。上面三条判红若是靠"S4 整条废掉"实现的，
   * 这一条会跟着红——那样守卫就从"太宽"翻到了"引不了法条"，同样是坏的。
   */
  it('逐字引条文仍然放行（自证上面三条不是把 S4 整条废掉）', () => {
    expect(
      unsanctionedMentions('《律师法》第十三条：没有取得律师执业证书的人员，不得以律师名义从事法律服务业务。'),
    ).toEqual([]);
  });

  /**
   * 【托住一次出现的东西，不许外溢到下一次】上面那组钉的是"否定词与它无关"；
   * 这一组钉的是**否定词确实托住了前一次出现，但不该顺带托住后一次**——
   * 它是"先写一句合规的话、再在同一口气里把人支出去"的完整形态，
   * 也是判定面（分句 + 12 字窗）唯一挡得住的东西。
   */
  it.each([
    // 只有"按分句判"才拦得住：否定搭配落在逗号前的那一句里
    ['跨分句外溢', '不劝你现在辞职，找个律师问问吧'],
    // 只有"12 字窗"才拦得住：否定搭配与后一次出现同在一句，但隔了很远
    ['同分句超窗外溢', '不劝找律师是我们的纪律但真到开庭那天最好还是请个律师'],
  ])('前一句的否定式托不住后一句：%s', (_label, t) => {
    expect(unsanctionedMentions(t).length, `这一句仍然被放行了：${t}`).toBeGreaterThan(0);
  });

  /**
   * 【否定词必须离得近、且不跨分句】"整句里有个否定词"不算托住——那正是最容易被绕过的形态：
   * 先写一句免责，再在同一段里把人支出去，而免责那半句让整段看起来合规。
   */
  it('隔了一句的否定词托不住后一句（变异：把判定面从"分句"改成整段 → 红）', () => {
    const hits = unsanctionedMentions('这不构成律师意见。另外，这个问题建议你找律师看看，他们更专业。');
    expect(hits.length, '否定式与违规句同段时，违规那句被放过了').toBeGreaterThan(0);
  });

  /**
   * 【每一条放行标记都要能命中它自己的例句】写坏的正则不会报错，只会**静默永绿**：
   * 它从此谁也不放行，而"谁也不放行"在这份判据里的表现与"扫描面很干净"完全一样。
   *
   * 【为什么 S4 只验例句、不验扫描面】扫描面里的法条引用只有无工具模式指南那一处
   *（《中华人民共和国律师法》第十三条），措辞随裁决会变；把它钉进这条自证里，
   * 下一次改文案时红的是"正则还活着吗"这条判据，指错方向。前两类反过来必须在扫描面里
   * 真的在用——一次都不命中说明它们已经与文案脱钩了。
   */
  it('放行标记各自能命中自己的例句，前两类在扫描面里真的在用', () => {
    expect(NEGATION.test('不构成律师意见')).toBe(true);
    expect(MANDATORY.test('法律上必须由执业律师做')).toBe(true);
    expect(citationSpans('《律师法》第十三条：没有取得律师执业证书的人员').length).toBe(1);
    expect(citationSpans('可以找律所代理（依据《律师法》第十三条）'), '没有冒号就不是引文段').toEqual([]);
    expect(titleSpans('《中华人民共和国律师法》').length).toBe(1);
    expect(quoteSpans('「建议咨询律师」').length).toBe(1);

    const corpus = SCANNED.map((f) => stripComments(fs.readFileSync(f, 'utf-8'))).join('\n');
    expect(NEGATION.test(corpus), 'NEGATION 在扫描面里一次都没命中——免责句多半被删了').toBe(true);
    expect(MANDATORY.test(corpus), 'MANDATORY 一次都没命中——闭合清单那一段多半没在渲染').toBe(true);
    for (const p of PINNED) {
      expect(corpus.includes(p), `钉住的例外「${p}」在扫描面里已经不存在了，把它删掉`).toBe(true);
    }
  });

  it('扫到的确实是那一堆文件（空名单会让上面那条永远绿）', () => {
    expect(SCANNED.length).toBeGreaterThan(200);
    expect(SCANNED.map(rel)).toContain('app/page.tsx');
    for (const f of ['lib/agent/charter.ts', 'lib/agent/prompt.ts', 'lib/agent/gate-marks.ts', 'lib/paste/guide.ts']) {
      expect(SCANNED.map(rel)).toContain(f);
    }
  });
});
