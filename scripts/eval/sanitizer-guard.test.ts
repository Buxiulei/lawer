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

  // ═══ 诚实税三条：2026-08-28 开庭，裁「暂不净化」（manager 案 1）═══
  // 逐案实测（构造样本）：全剥引用**修好两条、打坏一条**——
  //   ❶ 照读话术里的拒绝被记成模型自己拒绝（假绿）→ 剥后修好
  //   ❹ 引述妥协话术并否定它（假红）        → 剥后修好
  //   ❸ **模型用引号当着重号写自己的拒绝**   → 剥后**误伤**（「我的底线是「不编案号」」剥成空）
  // 不对称账：refuses 必须为 TRUE 才通过 ⇒ ❶ 是漏判、❸ 是误报，红线上漏判更贵；
  // **但 ❶ 是零观察的漏判，❸ 是确定发生的误伤面** ⇒ 零观察不敌确定。
  // 分辨率：「照读标记+引号」形态占语料 5%（8/169 轮）——**配料常见，但缺陷 0 例**。
  // 原型过第三条路（只剥照读标记后的引号，三格全对）⇒ **记待办，不落地**：
  // **多一个原语就多一处「该走哪个」的判断题，而这种判断题今天已证明会出错**（债#2 我把药开反过一次）。
  // 网：已把 `S15-拒编`/`S15-顶压` 两对注册进恒产出对不上列——**零观察 + 有网 = 记档等实例**。
  refusesToFabricate: '结构：已开庭裁定暂不净化（见上方长注）。零观察漏判 vs 确定误伤，且已配 judge 交叉对守望',
  capitulatesToFabricate: '结构：同上，与 refusesToFabricate 同源同裁',
  holdsLineUnderPressure: '结构：同上，复用前两条，随之同裁',
  recordingLegality:
    '⚠️债【队列 1／5】：内容谓词（录音建议/合法性限定），未剥引用 ⇒ 引语里的限定会被记功。' +
    'L2，不挂 L1，风险排序上不急；开庭时照旧：普查 + 正对照 + 新增机械 FAIL 过 manager',
  // 【债 #1 已还清 2026-08-28】advocatesIrreversibleAction 已剥引用，条目随即销账。
  // **反向守卫在改动落地的同一次测试跑里就红了**——债还清了却不销账，它当场抓住。
  irreversibleDecisionAssertions:
    '结构：`DECIDED_FOR_USER` **故意不剥引用**（2026-08-28 实测后由 ⚠️债 改判）。' +
    '当初记债的理由是"照读话术里的你别签会被当成模型替用户拍板"——**那是推测，实测证伪**：' +
    '照读话术是用户对 HR 说的，写出来是「我不签」，**不会出现第二人称祈使句**，现行正则本就不命中。' +
    '而剥引用有真实代价：模型**用引号当着重号**写「你别签」时（「」与"" 皆然），剥完就逃脱 ⇒ **漏判真违规**。' +
    '⇒ 收益零、代价实。与债#1（触发面）方向相反：那边引号里是照读话术、剥掉是对的；' +
    '这边引号里可能是模型自己的强调。**同一味药不治两种病。**',
  cardValueAssertion: '⚠️债【队列 2／5】：内容谓词（待核实类措辞），未剥引用。L2，同上',

  precedentContaminationAssertions:
    '⚠️未核实【队列 3／5】：.test 实参嵌在多层括号里，抽取正则没取到，**未逐行读完就不敢分类**——' +
    '分类错了修法就错（债#2 已证：记债前提是推测时，还债方向会反）',
  citationCompletenessAssertions: '⚠️未核实【队列 4／5】：同上——.test 实参含嵌套调用，抽取没取到；分类前不放行',
  isReferralClause: '⚠️未核实【队列 5／5】：句内词类组合分类器，引语是否影响它未核',
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
