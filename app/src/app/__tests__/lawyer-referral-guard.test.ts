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
// 【判定面：**这一句**，以及出现位置往前的 24 个字】拦的不是"律师"这两个字，
// 是**没有被否定式或清单托住的那一次出现**。所以先按句号/换行切句，再只看它前面那一小段：
// 否定词落在上一句里就不算托住它——"这不构成律师意见。另外建议你找律师看看"
// 整段里确实有否定词，而第二句正是裁决要禁的那一句。整段一起判的形态是：
// 先写一句免责、再在同一段里把人支出去，而免责那半句让整段看起来合规。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** app/src */
const SRC_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** 提到律师的两种写法。「法律顾问」「专业人士」那几种由 C04 判据 G2 在行为面拦（LAWYER_NAG）。 */
const MENTION = /律师|律所/g;

/** 判定窗：出现位置往前数这么多个字。取 24 是因为一句中文分句通常短于它。 */
const WINDOW = 24;

/**
 * ① 否定式与禁令。**这些词必须离"律师"足够近**（同在判定窗里）才算托住它。
 * 摘不干净的代价不是"多报一次"：有人为了让判据变绿，会把那句免责删掉——
 * 而那正好是唯一一句合规的话。
 */
const NEGATION = /不构成|不是|并非|不以|不自称|不冒充|请不起|没有|不劝|绝不劝|不必|不得|不许|不要|不用|不写|不该|不能|禁止|别/;

/**
 * ② 闭合清单的渲染。判定按**这几个标记**，不按文件豁免：整份文件豁免的形态是，
 * 有人往那个文件里加一句"拿不准就建议用户找律师"，而它是白名单文件，闸不响。
 */
const MANDATORY = /必须由执业律师|只能由执业律师|lawyerMandatory/;

/** ③ 法条 / 判例原文。逐字引用里的「律师」是被引的对象，不是我们说的话。 */
const STATUTE = /律师法|律师执业证书|民事诉讼法/;

/**
 * ④ 两处**逐字钉住**的例外，各配一条理由。
 *
 * 【为什么它们不能靠上面三条通过，也不该改写】「以执业律师的严谨方式工作」是
 * 身份边界那句话的前半截（后半截就是"但不自称律师"）——它讲的是**我们自己的标准**，
 * 既不是免责、也不是把人支出去。「律师 agent」是这份准则在文档里的名字（charter 的抬头），
 * 它随 charter 逐字进 system prompt，改它等于改 manager 维护的那份文件。
 * 钉成常量而不是放进上面的正则：例外要能被数清楚，多一条就得有人写下它为什么在这里。
 */
const PINNED = ['以执业律师的严谨方式工作', '律师 agent'];

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
 * 【为什么 lib 那侧只点这四个文件，而不是整个 lib】"律师"这两个字在 lib 里到处都是，
 * 而绝大多数是**内部叙述**（模块头注释、变量名、待律师复核那套机制）。
 * 整个 lib 一起扫的形态是：判据一片红，于是有人给它加一张长长的豁免名单，
 * 而豁免名单一长就没人看得懂它到底还在拦什么。这四个文件是**对外说话的那几份**：
 * 准则、system prompt、无工具模式开场白、闭合清单渲染。
 */
const SCANNED = [
  ...walk(path.join(SRC_ROOT, 'app')),
  ...walk(path.join(SRC_ROOT, 'components')),
  ...['lib/agent/charter.ts', 'lib/agent/prompt.ts', 'lib/agent/lawyer-mandatory.ts', 'lib/paste/guide.ts'].map(
    (f) => path.join(SRC_ROOT, f),
  ),
];
const rel = (file: string) => path.relative(SRC_ROOT, file);

/** 与 lawyer-self-claim-guard 同一份剥法：注释里讲往事不算对用户说话。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

/**
 * 这段文字里，有哪几次「律师」**没有**被上面四类托住。
 * 返回的是那几次出现前后的原文片段（给人看的，报错里要能照着搜到）。
 */
export function unsanctionedMentions(text: string): string[] {
  const out: string[] = [];
  // 按句号/换行切句：托住一次出现的必须是**同一句**里的否定式或清单标记
  for (const sentence of text.split(/[。\n]/)) {
    for (const m of sentence.matchAll(MENTION)) {
      const at = m.index ?? 0;
      const before = sentence.slice(Math.max(0, at - WINDOW), at);
      const around = sentence.replace(/\s+/g, ' ').trim();
      if (NEGATION.test(before)) continue;
      if (MANDATORY.test(around)) continue;
      if (STATUTE.test(around)) continue;
      if (PINNED.some((p) => around.includes(p))) continue;
      out.push(around.slice(0, 80));
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
        '由 lib/agent/lawyer-mandatory.ts 那一段统一说出口。',
    ).toEqual([]);
  });

  it('三类合法位置逐条放行（变异：删掉对应那一条 → 这一行红）', () => {
    // ① 否定式免责与禁令
    expect(unsanctionedMentions('这里提供法律信息与行动建议，不构成律师意见、不形成委托代理关系。')).toEqual([]);
    expect(unsanctionedMentions('7. 不劝找律师（§1 闭合清单例外）。')).toEqual([]);
    expect(unsanctionedMentions('你的用户请不起律师，仲裁与诉讼都要自己跑。')).toEqual([]);
    expect(unsanctionedMentions('禁止用「建议咨询律师」这类话收尾。')).toEqual([]);
    expect(unsanctionedMentions('清单之外一律不得把用户指向律师、律所或"专业人士"。')).toEqual([]);
    // ② 闭合清单的渲染
    expect(unsanctionedMentions('## 只有这几件事法律上必须由执业律师做（本段之外不许把用户支出去）')).toEqual([]);
    // ③ 法条原文
    expect(
      unsanctionedMentions('《律师法》第十三条：没有取得律师执业证书的人员，不得以律师名义从事法律服务业务。'),
    ).toEqual([]);
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
   * 【否定词必须离得近】"整句里有个否定词"不算托住——那正是最容易被绕过的形态：
   * 先写一句免责，再在同一段里把人支出去，而免责那半句让整段看起来合规。
   */
  it('隔了一句的否定词托不住后一句（变异：把判定面从"前 24 字"改成整段 → 红）', () => {
    const hits = unsanctionedMentions('这不构成律师意见。另外，这个问题建议你找律师看看，他们更专业。');
    expect(hits.length, '否定式与违规句同段时，违规那句被放过了').toBeGreaterThan(0);
  });

  /**
   * 【每一条放行标记都要能命中它自己的例句】写坏的正则不会报错，只会**静默永绿**：
   * 它从此谁也不放行，而"谁也不放行"在这份判据里的表现与"扫描面很干净"完全一样。
   *
   * 【为什么 STATUTE 只验例句、不验扫描面】产品面现在一处法条原文都没引到律师法，
   * 要求它在扫描面里出现等于逼人写一句用不着的话。前两类反过来必须在扫描面里真的在用——
   * 一次都不命中说明它们已经与文案脱钩了。
   */
  it('三类放行标记各自能命中自己的例句，前两类在扫描面里真的在用', () => {
    expect(NEGATION.test('不构成律师意见')).toBe(true);
    expect(MANDATORY.test('法律上必须由执业律师做')).toBe(true);
    expect(STATUTE.test('《中华人民共和国律师法》第十三条')).toBe(true);

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
    for (const f of ['lib/agent/charter.ts', 'lib/agent/prompt.ts', 'lib/paste/guide.ts']) {
      expect(SCANNED.map(rel)).toContain(f);
    }
  });
});
