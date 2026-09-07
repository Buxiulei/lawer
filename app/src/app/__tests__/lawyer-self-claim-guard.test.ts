// app/src/app/__tests__/lawyer-self-claim-guard.test.ts
// 产品面**不得自称律师**（《中华人民共和国律师法》第十三条，2017 年第三次修正）：
//「没有取得律师执业证书的人员，不得以律师名义从事法律服务业务；
//  除法律另有规定外，不得从事诉讼代理或者辩护业务。」
//
// 【拦的是"自称"，不是"律师"这两个字】三类说法长得很像，法律后果完全相反：
//   ① 自称  —「AI 律师」「律师意见」「我是律师」「由律师起草」 → 就是 §13 禁的那件事；
//   ② 免责  —「不构成律师意见」「不是律师」                    → §13 要的正是这句话；
//   ③ 指向第三方 —「到仲裁阶段可以找律师」「请律师看一眼」      → 说的是别人，不是自称。
// 一律按「出现『律师』就红」拦的形态是：为了让判据变绿，有人会把第②类那句免责删掉——
// 那正好把唯一一句合规的话拿走了。所以这份守卫**先摘掉否定式**，再找剩下的自称。
//
// 【为什么按文件扫，不靠复审】自称是顺手写出来的（"让 AI 律师帮你看看"读起来很自然），
// 而它渲染不报错、测试也不红。复审时有没有人注意到，不能是这条红线唯一的依靠。
//
// 【扫描范围与 page-domain-guard 同一片】app/src/app 与 app/src/components ——
// 用户看得见的字都在这里。lib/ 那侧是给模型读的 prompt 与 charter
//（charter.ts 里逐字写着"不自称律师"），措辞归 agent 纪律那条线管，不在本守卫内。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** app/src */
const SRC_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * 否定式：把这些**整段摘掉**之后再找自称。顺序无所谓——它们互不重叠。
 * 摘的是「否定词 + 自称」这一整块，不是只摘否定词：只摘否定词的形态是
 *「不构成律师意见」摘成「律师意见」，免责句反而变成了一条命中。
 */
const NEGATED = [/不构成律师意见/g, /不是律师/g, /非律师/g, /不以律师名义/g, /不自称律师/g];

/**
 * 自称的形态。**每一条都要能说出它禁的是哪一句话**：
 * 编不出例句的正则不该在这里，它只会在将来误伤一句正当的话。
 *
 * 【不带 g 标志】带 g 的正则 `.test()` 会推进 lastIndex，同一个对象连着问两遍
 * 第二遍就从上次停下的地方接着找——扫到第二个文件时结果开始漂，而它照常返回布尔值。
 */
const SELF_CLAIM: { re: RegExp; example: string }[] = [
  { re: /AI\s?律师/, example: 'AI 律师帮你看看' },
  { re: /智能律师/, example: '智能律师为你分析' },
  { re: /律师意见/, example: '这是一份律师意见' },
  { re: /我是律师/, example: '我是律师，我来说两句' },
  { re: /由律师/, example: '由律师起草' },
  { re: /律师团队/, example: '我们的律师团队' },
  { re: /专属律师/, example: '你的专属律师' },
  { re: /持证律师/, example: '持证律师审核过' },
];

/** 递归收集 .ts/.tsx，跳过 __tests__（判据里出现这些词是它在被验，不是在自称） */
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

const SCANNED = [...walk(path.join(SRC_ROOT, 'app')), ...walk(path.join(SRC_ROOT, 'components'))];
const rel = (file: string) => path.relative(SRC_ROOT, file);

/** 与 page-domain-guard 同一份剥法：注释里讲往事不算自称（理由见那份文件头）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

/** 摘掉否定式之后，这段文字里还剩下哪几种自称。 */
export function selfClaimsIn(text: string): string[] {
  let rest = text;
  for (const re of NEGATED) rest = rest.replace(re, '');
  return SELF_CLAIM.filter(({ re }) => re.test(rest)).map(({ re }) => re.source);
}

describe('产品面不得以律师名义自称（律师法 §13）', () => {
  it('页面与组件里一处自称都没有（变异：往 app/page.tsx 写一句「由律师起草」→ 红）', () => {
    const hits: string[] = [];
    for (const file of SCANNED) {
      const found = selfClaimsIn(stripComments(fs.readFileSync(file, 'utf-8')));
      if (found.length) hits.push(`${rel(file)} 里出现「${found.join('、')}」`);
    }
    expect(
      hits,
      `产品面出现了律师自称：\n  ${hits.join('\n  ')}\n` +
        '缺什么：这几句以律师名义提供法律服务，律师法 §13 明文禁止。\n' +
        '为什么缺：这类话读起来很自然、渲染不报错，只有这条闸拦得住。\n' +
        '怎么办：改成「法律信息」「陪跑意见」「AI 生成的分析」这类不冒用执业身份的说法；' +
        '要说的确实是第三方律师（「到仲裁阶段可以找律师」），换一个不含上面那几个词的写法。',
    ).toEqual([]);
  });

  it('免责句不算自称：「不构成律师意见」放行（变异：删掉 NEGATED 那几条 → 红）', () => {
    expect(selfClaimsIn('这里提供法律信息与行动建议，不构成律师意见、不形成委托代理关系。')).toEqual(
      [],
    );
    expect(selfClaimsIn('本平台不是律师事务所。')).toEqual([]);
  });

  it('指向第三方不算自称：「到仲裁阶段可以找律师」放行', () => {
    expect(selfClaimsIn('到仲裁阶段可以找律师代理，我们把材料整理好交给他。')).toEqual([]);
    expect(selfClaimsIn('建议请律师看一眼这份文书。')).toEqual([]);
  });

  it('每一条自称正则都真的能命中它自己的例句（写坏的正则会静默永绿）', () => {
    for (const { re, example } of SELF_CLAIM) {
      expect(selfClaimsIn(example), `${re.source} 命中不了它自己的例句「${example}」`).toContain(
        re.source,
      );
    }
  });

  it('扫到的确实是那一堆文件（空名单会让上面那条永远绿）', () => {
    expect(SCANNED.length).toBeGreaterThan(200);
    expect(SCANNED.map(rel)).toContain('app/page.tsx');
  });
});
