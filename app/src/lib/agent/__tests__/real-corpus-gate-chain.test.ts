// app/src/lib/agent/__tests__/real-corpus-gate-chain.test.ts
// 【⑥→⑧→⑨ 在**真知识库**上逐条跑一遍】
//
// 【为什么必须有这一条，而不是只有合成样本】S2 首轮的 blocker 就是这么漏掉的：
// 交互用例用的原文全是**单行**，而真库 318 条 statute_quotes 里 164 条是多行的，
// 其中相当一部分从第 2 行起才出现立法者的交叉引用（核心卡 §46 → 第三十八条 正是其一）。
// ⑧ 以 `「…」` 内联插入，免检面若按**行**算，第 2 行起就不在引号内了 →
// ⑥ 的漏网自检把闸自己刚补进来的原文记成漏网、⑨ 对着条文里的数字开火。
// 合成样本全绿，而这条路径在最主流的核心位上**恒发生**。
//
// 【这条判据吃的是产线数据，所以它会随知识库变红】那正是它的价值：
// 新入库一张卡，如果它的原文形态是闸处理不了的，这里当场红——
// 而不是等到某个用户的回复里出现一串莫名其妙的【条号待核验】。
//
// 【它只问两件事】① 闸对**自己的产物**不许开火（漏网 0、误标 0）；
// ② 放行集内的条被引用时不许被标。不问闸对模型编造的东西判得对不对——那是变异矩阵的活。
import { describe, expect, it } from 'vitest';

import { listPacks } from '@/lib/knowledge';

import { coreArticleKeys, renderCoreArticleFallback } from '../citation-block';
import type { KnowledgePack } from '../retrieval';
import { StatuteGuard, UNVERIFIED_STATUTE } from '../statute-guard';
import { applyValueGuard } from '../value-guard';

describe('真知识库全量：⑥→⑧→⑨ 对闸自己的产物不许开火', () => {
  it('每条 statute_quote 走一遍全链：⑥ 误标 0、⑥ 漏网 0、⑨ 误标 0', () => {
    const packs = listPacks() as unknown as KnowledgePack[];
    const sixMarked: string[] = [];
    const leaked: string[] = [];
    const nineMarked: string[] = [];
    /** 隔离臂：同一段正文里**该被判的那一处**没被判 */
    const nineSilent: string[] = [];
    let total = 0;
    let multiline = 0;

    for (const p of packs) {
      for (const q of p.facts?.statute_quotes ?? []) {
        if (!q?.law || !q?.article || !q?.text?.trim()) continue;
        total += 1;
        if (q.text.includes('\n')) multiline += 1;
        // 每条单独注入：这一轮手上只有它，于是"⑧ 补的就是 ⑥ 放行的"这条不变量被逐条检验
        const injected = [{ ...p, facts: { ...p.facts, statute_quotes: [q] } }] as KnowledgePack[];
        const guard = new StatuteGuard();
        guard.allowFrom(injected);
        // ⑥：核心位引用它自己（放行集内 ⇒ 一个标记都不该有）
        const afterSix = guard.push(`应当支付经济补偿，依据是《${q.law}》${q.article}。`) + guard.flush();
        if (afterSix.includes(UNVERIFIED_STATUTE)) sixMarked.push(`${p.id} ${q.article}`);
        // ⑧：把这条的逐字原文补进核心位
        const afterEight = renderCoreArticleFallback(afterSix, coreArticleKeys({ retrieved: injected }), injected);
        const leaks = guard.leakedIn(afterEight.text);
        if (leaks.length) leaked.push(`${p.id} ${q.article} → ${leaks.join('、')}`);
        // ⑨：⑧ 补进来的原文段整段免检（本轮没算过钱、卡里也没有 values）
        const afterNine = applyValueGuard(afterEight.text, { calcPayloads: [], retrieved: injected, deadlines: [] });
        if (afterNine.violations.length) {
          nineMarked.push(`${p.id} ${q.article} → ${afterNine.violations.map((v) => v.token).join('、')}`);
        }
        // 【隔离臂】同一段正文尾部追加一处**期限语境里的日期**，而本轮一条生效期限都没有 ⇒ 必判。
        //
        // 【为什么这一臂不能省（2026-09-08 复审 minor）】上面那个「⑨ 误标 0」有两种解释：
        // ① 免检面正确地罩住了 ⑧ 补进来的原文；② ⑨ 对这段正文**根本没开过火**
        //（免检面写宽了、捕获面写死了、这条卡的原文里恰好一个带单位的数都没有…）。
        // 两种解释在这一列上长得一模一样，而后者是"闸关了"。隔离臂把它们分开：
        // 同一段正文、同一份来源，只多一处该判的东西——它必须被判出来。
        const isolated = applyValueGuard(`${afterEight.text}\n这条时效最迟到 2099-12-31 到期。`, {
          calcPayloads: [],
          retrieved: injected,
          deadlines: [],
        });
        if (!isolated.violations.some((v) => v.kind === '日期' && v.token.includes('2099'))) {
          nineSilent.push(`${p.id} ${q.article}`);
        }
      }
    }

    // 语料本身的规模是判据的一部分：库空了或字段没解析出来时，上面三个"零"会变成空对空
    expect(total, '真库一条 statute_quote 都没读到 → 下面三条断言全是空对空').toBeGreaterThan(100);
    expect(multiline, '一条多行原文都没有 → 这条判据覆盖不到它要防的那个形态').toBeGreaterThan(10);
    expect(sixMarked, `⑥ 把放行集内的条标了：${sixMarked.slice(0, 5).join('｜')}`).toEqual([]);
    expect(leaked, `⑥ 把 ⑧ 补进来的原文记成漏网：${leaked.slice(0, 5).join('｜')}`).toEqual([]);
    expect(nineMarked, `⑨ 对 ⑧ 补进来的原文里的数字开火：${nineMarked.slice(0, 5).join('｜')}`).toEqual([]);
    expect(
      nineSilent,
      `⑨ 在这些卡的正文上**一处都判不出来** → 上面那个"误标 0"是闸没开火，不是免检面对：${nineSilent.slice(0, 5).join('｜')}`,
    ).toEqual([]);
  });

  /**
   * 【法定倍数：条文写汉字，模型写阿拉伯】真库里「二倍工资」「三倍」「百分之十」全是汉字写法，
   * 而模型惯写「2 倍」「10%」。不跨数字体系互认的形态是：模型**引对了条、也抄对了数**，
   * ⑨ 照样标【数值无来源】，并给出一条它根本用不上的出路（「用 claim_calc 算」
   * 算不出一个法定倍数）。这是每轮几乎必现的数字类别，会直接顶穿 2% 的替换率预算。
   *
   * 不写死卡 id：这条要守的是**机制**，卡改了名或换了张卡它都该继续有效；
   * 但会先断言"真库里确有这种形态"，免得哪天语料变了之后它变成一条空跑的绿灯。
   */
  it('真库里的汉字倍数，模型用阿拉伯写法引用时放行（不认汉字 → 每轮误标）', () => {
    const packs = listPacks() as unknown as KnowledgePack[];
    const samples: { pack: KnowledgePack; arabic: string }[] = [];
    for (const p of packs) {
      for (const q of p.facts?.statute_quotes ?? []) {
        const m = /([一二三四五六七八九十]{1,4})倍/.exec(q?.text ?? '');
        if (!m) continue;
        const n = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1] as '一'];
        if (n === undefined) continue;
        samples.push({ pack: { ...p, facts: { ...p.facts, statute_quotes: [q] } }, arabic: `${n} 倍` });
      }
    }
    expect(samples.length, '真库里一条汉字倍数原文都没有 → 这条判据是空跑的绿灯').toBeGreaterThan(0);
    const missed = samples.filter(
      (s) => applyValueGuard(`这一项按 ${s.arabic}计算。`, { calcPayloads: [], retrieved: [s.pack], deadlines: [] }).violations.length > 0,
    );
    expect(missed.map((s) => `${s.pack.id} ${s.arabic}`), '条文里写着这个倍数，模型用阿拉伯写法引用却被标无来源').toEqual([]);
  });
});
