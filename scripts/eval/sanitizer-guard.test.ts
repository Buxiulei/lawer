/**
 * 管道守卫：**把「所有内容谓词统一走净化原语」从文档变成机检**（manager 2026-08-28 裁定②）。
 *
 * 【为什么要有它】2026-08-28 一天之内，同一个洞出了三个口：
 *   · `未替决` 用裸 `absent`（文档明写「所有 absent() 类断言**统一**走 absentOutsideNegation」）
 *   · `handsBackDecision` 不剥引用 ⇒ **一条 L1 把给用户照读的话术当成交还，放行了**
 *   · 同一函数不剥否定（这一格后来查明**不该剥**，两侧各用各的药）
 * 共同成因是**「解药在仓里、新判据没被强制走它」**。
 * **约定要么变成机检，要么迟早再漏。**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SANITIZERS = ['stripQuotedAndDisclaimed', 'stripQuotedAndNegated'];

/**
 * 豁免表。**每一条都要写理由**，理由分三类：
 *   结构   —— 正则匹的是结构（标点、行首标记、块引用边界），不是用户内容
 *   原语   —— 它自己就是那层原语
 *   ⚠️债   —— 内容谓词但尚未净化。**列在这里不是"没问题"，是"债务在账上"**，
 *              每条都要说清归哪张单。落地前须各自做 diff 普查（不许静默扩红线）。
 */
const EXEMPT: Record<string, string> = {
  sentenceAt: '结构：SEP 匹的是单个标点字符，与内容无关',
  precedentSpans: '结构：PRECEDENT_MARK 匹的是行首判例标记',
  landlineMarkAssertions: '结构：MARK 匹的是号码近邻窗口里的座机标记',
  unstructuredSourceArticles: '结构：EXCERPT_MARK 匹的是块引用边界内的原文标记',
  absent: '原语：它就是"不净化"的那一版；**调用方**该不该改走 absentOutsideNegation 归 ④',

  refusesToFabricate: '⚠️债：内容谓词（拒绝编造的措辞），未剥引用 ⇒ 引语里的拒绝会被记功。归 ④',
  capitulatesToFabricate: '⚠️债：内容谓词（妥协编造的措辞），未剥引用。归 ④',
  holdsLineUnderPressure: '⚠️债：内容谓词，复用上面两条，同样未剥引用。归 ④',
  recordingLegality: '⚠️债：内容谓词（录音建议/合法性限定），未剥引用 ⇒ 引语里的限定会被记功。归 ④',
  // 【债 #1 已还清 2026-08-28】advocatesIrreversibleAction 已剥引用，条目随即销账。
  // **反向守卫在改动落地的同一次测试跑里就红了**——债还清了却不销账，它当场抓住。
  irreversibleDecisionAssertions:
    '⚠️债：`DECIDED_FOR_USER` 直接打 userVisibleText，未剥引用 ⇒ ' +
    '照读话术里的"你别签"会被当成模型替用户拍板。归 ④',
  cardValueAssertion: '⚠️债：内容谓词（待核实类措辞），未剥引用。归 ④',

  precedentContaminationAssertions: '⚠️未核实：它的 .test 嵌在多层括号里，本次抽取正则没取到实参，未逐行读完就不敢分类',
  citationCompletenessAssertions: '⚠️未核实：同上——.test 实参含嵌套调用，抽取没取到；分类前不放行',
  isReferralClause: '⚠️未核实：句内词类组合分类器，引语是否影响它未核',
};

function predicatesWithRegexTests(): { name: string; sanitized: boolean }[] {
  const raw = readFileSync(new URL('./assertions.ts', import.meta.url), 'utf8');
  // 【必须剥注释】守卫被自己的解释性注释骗过，2026-08-27 发生过一次：
  // 注释里引用了被守的形状本身，删掉真调用点后正则仍匹到注释，**守卫照样绿**。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const parts = src.split(/^(?:export )?function (\w+)/m);
  const out: { name: string; sanitized: boolean }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const [name, body] = [parts[i], parts[i + 1]];
    if (!body.includes('.test(')) continue;
    out.push({ name, sanitized: SANITIZERS.some((s) => body.includes(s)) });
  }
  return out;
}

describe('管道守卫：内容谓词必须经净化原语构造', () => {
  const found = predicatesWithRegexTests();

  it('🔒 **守卫自身的地板**：切函数失败会让它找到 0 个然后空过', () => {
    // 「找不到」与「本来就没有」长得一模一样——这条断言是唯一能把两者分开的东西。
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found.map((f) => f.name)).toContain('handsBackDecision');
    expect(found.find((f) => f.name === 'handsBackDecision')!.sanitized).toBe(true);
  });

  it('每个未净化的谓词都必须在豁免表里，且带理由', () => {
    const missing = found.filter((f) => !f.sanitized && !EXEMPT[f.name]).map((f) => f.name);
    expect(missing, `这些谓词直接对未净化文本跑正则，且不在豁免表里：${missing.join('、')}`).toEqual([]);
  });

  it('豁免理由不许敷衍（≥12 字，且要说清是「结构」「原语」还是「债」）', () => {
    for (const [name, why] of Object.entries(EXEMPT)) {
      expect(why.length, `${name} 的豁免理由太短`).toBeGreaterThanOrEqual(12);
      expect(why, `${name} 的豁免理由没分类`).toMatch(/^(结构|原语|⚠️债|⚠️未核实)/);
    }
  });

  it('**反向**：豁免表不许有过期条目（函数没了，或它已经净化了）', () => {
    const names = new Set(found.map((f) => f.name));
    const sanitizedNow = new Set(found.filter((f) => f.sanitized).map((f) => f.name));
    const stale = Object.keys(EXEMPT).filter((n) => !names.has(n) || sanitizedNow.has(n));
    expect(stale, `豁免表里这些条目已经过期：${stale.join('、')}`).toEqual([]);
  });
});
