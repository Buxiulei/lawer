// app/src/lib/agent/__tests__/gate-chain.test.ts
// 【闸链的顺序判据 + 每对相邻闸一条交互用例】（设计稿 §4.3）
//
// 【为什么"顺序"需要判据】十道闸的先后此前只存在于 orchestrator.ts 的行序里。
// 行序是**看不见的契约**：往中间插一段、把两块调个个儿，tsc 绿、全套测试绿，
// 而后果是确定性的（⑧ 补进的原文被 ⑦ 剥掉、⑨ 去判 ⑧ 还没补的正文……）。
//
// 【为什么"相邻对"是正确的粒度】闸与闸之间的耦合只发生在相邻两道之间：
// 前一道的产物就是后一道的输入。全排列去测是 90 对，其中 81 对没有接触面；
// 相邻 9 对覆盖了全部真实接触面，且每一条都能说出"它们之间传的是什么"。
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GATE_CHAIN,
  RATE_GATES,
  REPLACE_RATE_BUDGET,
  VALUE_GUARD_MODE,
  gateOf,
  liveGates,
  newGateReport,
  summarizeGateReport,
  tallyGate,
  valueGuardText,
} from '../gate-chain';
import { CitationGuard, UNVERIFIED_CITATION } from '../citation-guard';
import { StatuteGuard, UNVERIFIED_STATUTE } from '../statute-guard';
import { applyValueGuard, VALUE_MISMATCH, VALUE_UNSOURCED } from '../value-guard';
import {
  CORE_ARTICLE_MAP_PACK_ID,
  coreArticleKeys,
  precedentContamination,
  renderCoreArticleFallback,
  stripUnsupportedQuotes,
} from '../citation-block';
import { applyLeverageGate, buildCrisisOpener, leverageSubject, stripNbdpsyPitch } from '../crisis';
import type { KnowledgePack } from '../retrieval';
import type { AgentEvent } from '../events';
import { runTurn } from '../orchestrator';

const SRC = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

/** 一句纯情感杠杆：剥完一句不剩 ⇒ 必落确定性兜底（与 domain-wiring 用的是同一句） */
const LEVERAGE_LINE = '想想你爸妈，他们该多伤心。';
/** 一句自家付费推介（与 crisis.test.ts 用的是同一句） */
const PITCH_LINE = '如果你愿意，我可以帮你约 NBDpsy。';
/** 首段用的热线事实。号码是编的——这里验的是"它有没有被后面的闸弄丢"，不是号码本身 */
const CRISIS_FACTS = {
  hotlines: [{ name: '测试热线', phone: '12345', category: 'crisis' as const, status: 'usable' as const, hours: '全天' }],
};

/** 一张带逐字条文的法条卡 */
function statutePack(quotes: { law: string; article: string; text: string }[]): KnowledgePack {
  return {
    id: 'statute-fake',
    type: '法条卡',
    title: '测试用法条卡',
    keywords: [],
    applies_to: [],
    region: '全国',
    confidence: '原文核实',
    updated: '2026-09-08',
    body: quotes.map((q) => `${q.article}　${q.text}`).join('\n'),
    facts: { statute_quotes: quotes },
  };
}

/** 一张判例卡：卡里**没有**「次日报到 / 新岗位」，所以这两样出现在判例句里就是污染 */
const PRECEDENT_CARD: KnowledgePack = {
  ...statutePack([]),
  id: 'case-fake',
  type: '判例卡',
  title: '判例卡',
  body: '本院认为，用工方应当支付。',
  facts: { case_facts: { case_no: '（2023）京03民终15407号', gist: '用工方应当支付' } },
};

describe('一、顺序表自身自洽', () => {
  it('order 与下标恒等，id 不重复（有人插一道闸忘了改后面的 order → 红）', () => {
    expect(GATE_CHAIN.map((g) => g.order)).toEqual(GATE_CHAIN.map((_, i) => i + 1));
    expect(new Set(GATE_CHAIN.map((g) => g.id)).size).toBe(GATE_CHAIN.length);
  });

  it('设计稿 §4.3 的十道一道不少（少一道就是有人把它从链上摘了）', () => {
    expect(GATE_CHAIN).toHaveLength(10);
    expect(GATE_CHAIN.map((g) => g.id)).toEqual([
      'crisis_opener',
      'leverage',
      'nbdpsy_pitch',
      'precedent_contamination',
      'citation_guard',
      'statute_guard',
      'strip_unsupported_quotes',
      'core_article_fallback',
      'value_guard',
      'practice_boundary',
    ]);
  });

  it('⑩ 仍是 planned：**不许假装它在守**（设计稿 §5 第 9 项，另属一片）', () => {
    expect(gateOf('practice_boundary').status).toBe('planned');
    expect(liveGates()).toHaveLength(9);
  });

  it('每道 live 闸都必须有锚串（没有锚 = 下面那条"实现序"判据对它恒真）', () => {
    for (const g of liveGates()) expect(g.anchor, `${g.id} 没有锚串`).toBeTruthy();
  });
});

describe('二、实现序 = 表序（按 stage 分段比，不拿行号硬比）', () => {
  it('每道 live 闸在 orchestrator 里确有调用点（改了名而表没跟上 → 红）', () => {
    for (const g of liveGates()) {
      expect(SRC.includes(g.anchor!), `${g.id} 的锚串「${g.anchor}」在 orchestrator.ts 里找不到`).toBe(true);
    }
  });

  it('流上两道：⑤ 先于 ⑥，且都在 runOnce 里（把 ⑥ 挪到 ⑤ 前面 → 半截案号会先被 ⑥ 看到 → 红）', () => {
    const chained = SRC.indexOf('statutes.push(citations.push(');
    expect(chained, '⑤⑥ 不再是「⑥ 吃 ⑤ 的产物」这个形态').toBeGreaterThan(-1);
    // 流末冲刷同理：⑤ 的尾巴要再过一遍 ⑥，反过来那半截就直接漏出去了
    expect(SRC).toContain('statutes.push(citations.flush()) + statutes.flush()');
  });

  it('post 段的实现序与表序一致，**已登记的偏差除外**', () => {
    /**
     * 【登记在案的唯一一处偏差】④ 判例污染的调用点在源码里排在 ③ 推介闸**之前**。
     *
     * 为什么它是安全的、且不值得为它改动 orchestrator：
     * ④ 的 `effect === 'observe'` —— 它**一个字都不改**，只发 notice。
     * 一道不改正文的闸，位置换到哪里都不会改变用户看到的东西；
     * 唯一的差别是它读到的是剥推销句之前还是之后的正文，而这两者对
     * 「判例引用句里有没有混进本案事实」这个判断没有交集。
     *
     * **登记它而不是消灭它**：真去调换两块代码是一次没人要求的行为变更
     *（④ 会改成读剥后正文），而收益只是让一张表读起来更整齐。
     * 但也不能不写——不写就变成"表和实现不一样，没人知道"。
     */
    const KNOWN_DEVIATION = { earlier: 'precedent_contamination', later: 'nbdpsy_pitch' } as const;
    expect(gateOf(KNOWN_DEVIATION.earlier).effect, '这处偏差的全部安全性来自「它不改正文」').toBe('observe');

    const posts = liveGates().filter((g) => g.stage === 'post');
    const at = new Map(posts.map((g) => [g.id, SRC.indexOf(g.anchor!)]));
    const outOfOrder: string[] = [];
    for (let i = 1; i < posts.length; i++) {
      const prev = posts[i - 1];
      const cur = posts[i];
      if (at.get(prev.id)! < at.get(cur.id)!) continue;
      if (prev.id === KNOWN_DEVIATION.later && cur.id === KNOWN_DEVIATION.earlier) continue;
      outOfOrder.push(`${prev.id} 应先于 ${cur.id}，实际相反`);
    }
    expect(
      outOfOrder,
      `orchestrator 的实现序与 GATE_CHAIN 对不上：\n  ${outOfOrder.join('\n  ')}\n` +
        '→ 要么改回顺序，要么在本判据里登记这处偏差**并写明为什么它不改变用户看到的东西**。',
    ).toEqual([]);
  });
});

describe('三、每对相邻闸一条交互用例（9 对）', () => {
  /**
   * 【这四条为什么改成真跑两道闸（2026-09-08 复审 minor）】原版里 ①→② / ②→③ 是对
   * orchestrator.ts 的**源码正则扫描**，③→④ 是常量 + 源码扫描，④→⑤ 的占位符是手写的、
   * 没经过 CitationGuard。它们能证明"源码长这样"，证明不了"两道闸接触时会怎样"——
   * 把 ⑤ 从流上摘掉，④→⑤ 照样绿。源码扫描留着（它守的是接线点没被挪走），
   * 但每一条都补上一次**真调用**，且都带负对照：证明那个"通过"不是因为它压根没判。
   */
  it('①→② 首段不进杠杆闸：模型段整段是杠杆时，② 必须回落兜底而不是"剥完还剩首段"', () => {
    const opener = buildCrisisOpener(CRISIS_FACTS);
    expect(opener).toContain('12345');
    // 正确接法：只把模型段喂给 ②。整段是杠杆 → 剥空 → 回落确定性安全回复
    const right = applyLeverageGate(leverageSubject({ modelBody: LEVERAGE_LINE, userTurns: ['我撑不住了'] }));
    expect(right.outcome, '这句是纯杠杆，剥完一句不剩 ⇒ 必落兜底').toBe('fallback');
    expect(right.text.trim(), '兜底正文必须是有内容的陪伴，不是空串').not.toBe('');
    expect(`${opener}\n\n${right.text}`).toContain('12345');

    // 负对照（错误接法）：把含首段的全文当模型段喂进去。首段本身不含杠杆，于是
    // **"剥空即回落"这条被首段顶掉**——闸报 stripped、不回落，用户拿到的是
    // 首段 + 一段空白：最不该失败的那一轮，陪伴的话一句都没有。
    const wrong = applyLeverageGate(leverageSubject({ modelBody: `${opener}\n\n${LEVERAGE_LINE}`, userTurns: ['我撑不住了'] }));
    expect(wrong.outcome, '首段进了 ② ⇒ 它替模型段撑住了"还剩东西"这个判断').not.toBe('fallback');
    expect(wrong.text.replace(opener, '').trim(), '模型段被剥空却没有回落，剩下的只有我们自己的首段').toBe('');

    // 接线点也钉住：判的必须是 modelBody 那个变量
    expect(SRC).toMatch(/applyLeverageGate\(\s*\n\s*leverageSubject\(\{\s*\n\s*modelBody,/);
    expect(SRC).not.toMatch(/leverageSubject\(\{\s*\n\s*modelBody:\s*text/);
  });

  it('②→③ ② 剥完的正文进 ③：③ 只剥推介句，② 已剥过的部分与首段都不受影响', () => {
    const opener = buildCrisisOpener(CRISIS_FACTS);
    const body = `我在。${LEVERAGE_LINE}${PITCH_LINE}现在告诉我你在哪。`;
    const two = applyLeverageGate(leverageSubject({ modelBody: body, userTurns: ['我撑不住了'] }));
    expect(two.outcome).toBe('stripped');
    const three = stripNbdpsyPitch(two.text);
    expect(three, '③ 没把推介句剥掉').not.toContain('NBDpsy');
    expect(three).toContain('现在告诉我你在哪');
    expect(`${opener}\n\n${three}`).toContain('12345'); // 首段全程不参与两道剥除
    // 负对照：把同一句喂给 ③ 之前不经 ②，杠杆句会留在正文里——证明上面那个"干净"来自 ②
    expect(stripNbdpsyPitch(body)).toContain(LEVERAGE_LINE.slice(0, 4));
    expect(SRC).toMatch(/const \{ opener, body \} = crisis\.triggered \? splitCrisisOpener\(text, crisisPack\)/);
    expect(SRC).toContain('text = opener ? `${opener}\\n\\n${kept}` : kept;');
  });

  it('③→④ 偏差之所以无害：③ 剥不剥推介句，④ 的判定逐字相同（④ 一旦改正文 → 这条失去前提）', () => {
    expect(gateOf('precedent_contamination').effect).toBe('observe');
    const withPitch = `参考案例一，其中提到次日报到与新岗位。${PITCH_LINE}`;
    const before = precedentContamination(withPitch, [PRECEDENT_CARD], '次日报到 新岗位');
    const after = precedentContamination(stripNbdpsyPitch(withPitch), [PRECEDENT_CARD], '次日报到 新岗位');
    expect(before.length, '样本没触发 ④ → 这条比较是空对空').toBeGreaterThan(0);
    expect(after, '③ 的剥除改变了 ④ 的判定 → 这处顺序偏差不再是"无害"，必须真去调换两块代码').toEqual(before);
    // 实现侧同源：④ 的返回值只进 notice，不回写 text
    const at = SRC.indexOf('precedentContamination(');
    expect(SRC.slice(at, at + 1200)).toContain("code: 'PRECEDENT_CONTAMINATED'");
    expect(SRC.slice(at, at + 1200), '④ 一旦开始回写 text，它与 ③ 的先后就不再是可登记的偏差').not.toMatch(/\btext = /);
  });

  it('④→⑤ ④ 读的是**真过完 ⑤** 的正文：⑤ 换上的占位符不会被当成案号', () => {
    // 判例标记就是那个案号本身：⑤ 换掉它之后，这一句在 ④ 眼里不再是"判例引用句"
    const raw = '参考（2023）京0105民初88888号，其中提到次日报到与新岗位。';
    // 占位符由 ⑤ 自己产出，不是手写的——手写的形态是：把 ⑤ 从流上摘掉，这条照样绿
    const citations = new CitationGuard();
    const afterFive = citations.push(raw) + citations.flush();
    expect(afterFive).toContain(UNVERIFIED_CITATION);
    expect(afterFive).not.toContain('88888');
    expect(
      precedentContamination(afterFive, [PRECEDENT_CARD], '次日报到 新岗位'),
      '占位符被当成案号 → ④ 会把整句当判例引用句判污染',
    ).toEqual([]);
    // 负对照：⑤ 之前的那一版**是**会报污染的，证明上面那个空数组来自 ⑤ 的产物
    expect(precedentContamination(raw, [PRECEDENT_CARD], '次日报到 新岗位').length).toBeGreaterThan(0);
  });

  it('⑤→⑥ 链在一起：同一片里案号被换、条号被标，互不吃掉对方', () => {
    const citations = new CitationGuard();
    const statutes = new StatuteGuard();
    statutes.allowFrom([statutePack([{ law: '某某某某法', article: '第四十六条', text: '有下列情形之一……' }])]);
    const chunk = '参考（2023）京0105民初88888号，并依《某某某某法》第四十八条主张。';
    const out = statutes.push(citations.push(chunk)) + statutes.push(citations.flush()) + statutes.flush();
    expect(out).toContain(UNVERIFIED_CITATION); // ⑤ 开火
    expect(out).toContain(`第四十八条${UNVERIFIED_STATUTE}`); // ⑥ 开火
    expect(out).not.toContain('88888');
  });

  it('⑥→⑦ ⑥ 的标记落在引号外，不影响 ⑦ 的引号内比对（把标记插进引号里 → 红）', () => {
    const injected = [statutePack([{ law: '某某某某法', article: '第四十六条', text: '有下列情形之一的，应当支付经济补偿' }])];
    const statutes = new StatuteGuard();
    statutes.allowFrom(injected);
    const raw = '依《某某某某法》第四十六条：「有下列情形之一的，应当支付经济补偿」；另见《某某某某法》第四十八条。';
    const afterSix = statutes.push(raw) + statutes.flush();
    expect(afterSix).toContain(`第四十八条${UNVERIFIED_STATUTE}`);
    const afterSeven = stripUnsupportedQuotes(afterSix, injected);
    expect(afterSeven.stripped, '⑥ 的标记把 ⑦ 的引文比对搅坏了').toEqual([]);
  });

  it('⑦→⑧ ⑧ 补进来的原文再过一遍 ⑦ 不会被剥（顺序反过来就是这条会红）', () => {
    const quote = '按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付';
    const injected = [statutePack([{ law: '某某某某法', article: '第四十七条', text: quote }])];
    const text = '这笔钱应当支付：依《某某某某法》第四十七条。';
    const seven = stripUnsupportedQuotes(text, injected);
    const eight = renderCoreArticleFallback(seven.text, coreArticleKeys({ retrieved: injected }), injected);
    expect(eight.added).toHaveLength(1);
    expect(eight.text).toContain(quote);
    // 把 ⑧ 的产物再喂一遍 ⑦：它是卡里的逐字原文，天然过闸
    expect(stripUnsupportedQuotes(eight.text, injected).stripped).toEqual([]);
  });

  it('⑥→⑧ 不变量：⑧ 能补原文的每一条，⑥ 都必须放行（设计稿 §4.3 点名的那一条）', () => {
    const injected = [
      statutePack([
        { law: '某某某某法', article: '第四十六条', text: '有下列情形之一的，应当支付经济补偿' },
        { law: '某某某某法', article: '第四十七条', text: '按劳动者在本单位工作的年限……' },
      ]),
    ];
    const statutes = new StatuteGuard();
    statutes.allowFrom(injected);
    // ⑧ 的取料面就是 injected 的 statute_quotes；逐条问 ⑥ 放不放行
    for (const q of injected[0].facts!.statute_quotes!) {
      expect(statutes.isSupported(`《${q.law}》${q.article}`), `⑥ 会把 ⑧ 要补的 ${q.article} 标掉`).toBe(true);
      expect(statutes.isSupported(q.article), `⑥ 对裸条号 ${q.article} 的口径与 ⑧ 不一致`).toBe(true);
    }
    // 端到端：核心位光秃 → ⑥ 放行 → ⑧ 找得到那一处并补上原文
    const afterSix = statutes.push('应当支付经济补偿，依据是第四十六条。') + statutes.flush();
    expect(afterSix).not.toContain(UNVERIFIED_STATUTE);
    const eight = renderCoreArticleFallback(afterSix, coreArticleKeys({ retrieved: injected }), injected);
    expect(eight.added).toHaveLength(1);
  });

  /**
   * 【⑥→⑧ 的**多行**形态（2026-09-08 复审 blocker）】上一条用的是单行原文，而真库
   * 318 条 statute_quotes 里 164 条是多行的，其中相当一部分**从第 2 行起**才出现
   * 立法者的交叉引用（§46 的（一）……第三十八条…… 正是最主流的那一条）。
   * ⑧ 以 `「…」` 内联插入，若免检面按**行**算，第 2 行起的交叉引用就不在引号内了 →
   * ⑥ 的漏网自检把**闸自己刚补进来的原文**记成漏网 → gate_report 报「闸自己漏了」，
   * 而闸什么都没做错。单行样本恰好绕开这条，所以它必须单独有一条。
   */
  it('⑥→⑧ 多行原文：⑧ 补进来的段落里，第 2 行起的交叉引用不算 ⑥ 的漏网', () => {
    const multi = ['有下列情形之一的，应当支付经济补偿：', '（一）依照本法第三十八条规定解除的；', '（二）依照本法第三十六条规定解除的。'].join('\n');
    const injected = [statutePack([{ law: '某某某某法', article: '第四十六条', text: multi }])];
    const statutes = new StatuteGuard();
    statutes.allowFrom(injected);
    const afterSix = statutes.push('应当支付经济补偿，依据是《某某某某法》第四十六条。') + statutes.flush();
    expect(afterSix).not.toContain(UNVERIFIED_STATUTE);
    const eight = renderCoreArticleFallback(afterSix, coreArticleKeys({ retrieved: injected }), injected);
    expect(eight.added).toHaveLength(1);
    expect(eight.text, '⑧ 补进来的确实是多行原文').toContain('第三十八条');
    expect(
      statutes.leakedIn(eight.text),
      '⑧ 补进来的原文第 2 行起被记成漏网 → 用户面没有任何标记，gate_report 却报「闸自己漏了」',
    ).toEqual([]);
    // 负对照：同样两条交叉引用挪到引号外（模型自己写的），就必须被记成漏网
    expect(statutes.leakedIn('另见《某某某某法》第三十八条与《某某某某法》第三十六条。')).toHaveLength(2);
  });

  it('⑧→⑨ ⑧ 补进来的原文段 ⑨ 免检（⑨ 排到 ⑧ 前面、或去掉引号免检 → 红）', () => {
    const quote = '经济补偿的月工资高于当地上年度职工月平均工资三倍的，按三倍数额支付，且不超过 60000 元';
    const injected = [statutePack([{ law: '某某某某法', article: '第四十七条', text: quote }])];
    const eight = renderCoreArticleFallback(
      '这笔钱应当支付：依《某某某某法》第四十七条。',
      coreArticleKeys({ retrieved: injected }),
      injected,
    );
    expect(eight.added).toHaveLength(1);
    // ⑨ 的放行原料是空的（本轮没算过钱、卡里没有 values），但原文里的数字仍不许被标
    const nine = applyValueGuard(eight.text, { calcPayloads: [], retrieved: injected, deadlines: [] });
    expect(nine.violations, `⑨ 把 ⑧ 补进来的原文里的数字标了：${nine.violations.map((v) => v.token).join('、')}`).toEqual([]);
    expect(nine.text).not.toContain(VALUE_UNSOURCED);
    // 负对照：同样的数字挪到引号外就要被标——证明上面那个"零"不是因为它压根没被捕
    // （数字换成卡里没有的那个：60000 本身写在这一条原文里，它**有来源**，
    //   在引号外照样放行——负对照要证的是"捕得到"，不是"引号外一律标"）
    const outside = applyValueGuard('这一项不超过 77777 元。', { calcPayloads: [], retrieved: injected, deadlines: [] });
    expect(outside.violations).toHaveLength(1);
  });

  /**
   * 【⑧→⑨ 的**多行**形态（2026-09-08 复审 blocker 的另一半）】与 ⑥→⑧ 同一个根因：
   * ⑨ 原先手抄了一份"按行数引号奇偶"的免检实现，于是"⑧ 补一条原文，⑨ 不许多开一次火"
   * 这条不变量**只在单行原文上成立**。真库里带数字的多行条文是实际存在的
   *（个税法 §3「百分之三至百分之四十五」、竞业指引 §13「50%」都在多行条文里）。
   */
  it('⑧→⑨ 多行原文：⑨ 对 ⑧ 补进来的第 2 行起的数字/日期同样免检', () => {
    // 【为什么原文里要放一个"期限语境里的日期"】⑨ 有两道防线会挡下 ⑧ 的产物：
    // ①「引号内免检」；②「本轮取到的法条原文里写着这个数」。金额与倍数**两道都挡得住**，
    // 于是把 ① 换成按行算的旧实现，用例照样绿——**一条被另一条遮蔽的判据等于没有**。
    // 日期只认 `deadline_list` 出参，②那条对它无效，所以它是 ① 的隔离样本。
    const multi = [
      '经济补偿按下列标准支付：',
      '（一）月工资高于当地上年度职工月平均工资 3 倍的，按 3 倍数额支付；',
      '（二）劳动合同于 2026 年 3 月 1 日届满的，支付年限最高不超过 12 个月，封顶 60000 元。',
    ].join('\n');
    const injected = [statutePack([{ law: '某某某某法', article: '第四十七条', text: multi }])];
    const eight = renderCoreArticleFallback(
      '这笔钱应当支付：依《某某某某法》第四十七条。',
      coreArticleKeys({ retrieved: injected }),
      injected,
    );
    expect(eight.added).toHaveLength(1);
    expect(eight.text).toContain('60000 元');
    expect(eight.text).toContain('2026 年 3 月 1 日');
    const nine = applyValueGuard(eight.text, { calcPayloads: [], retrieved: injected, deadlines: [] });
    expect(
      nine.violations.map((v) => v.token),
      '⑨ 把 ⑧ 补进来的多行原文里第 2 行起的数字/日期标了 —— 这一处每轮都会发生在最主流的核心位路径上',
    ).toEqual([]);
    // 负对照：同一个日期挪到引号外、同样带期限语境 ⇒ 必须被标（证明上面那个"零"来自免检面）
    const outside = applyValueGuard('这份合同于 2026 年 3 月 1 日届满。', {
      calcPayloads: [],
      retrieved: injected,
      deadlines: [],
    });
    expect(outside.violations.map((v) => v.kind)).toEqual(['日期']);
  });

  it('⑨→⑩ ⑨ 的标记不含承诺/边界字面，⑩ 接线时不会被自己人触发', () => {
    // ⑩ 是字面表闸，判的是"正文里有没有承诺结果/以律师名义"这类字面。
    // ⑨ 排在它前面，所以 ⑨ 插进正文的每一个字都会被 ⑩ 看到——
    // 标记里一旦混进「一定」「胜」「律师」这类词，⑩ 上线当天就会对着我们自己的标记开火。
    const PROMISE_WORDS = ['一定', '必然', '肯定', '稳赢', '胜率', '包赢', '律师', '代理'];
    for (const marker of [VALUE_UNSOURCED, VALUE_MISMATCH, UNVERIFIED_STATUTE, UNVERIFIED_CITATION]) {
      for (const w of PROMISE_WORDS) expect(marker.includes(w), `标记「${marker}」含承诺/边界字面「${w}」`).toBe(false);
    }
    // 且 ⑩ 必须排在 ⑨ 之后：反过来它会去判一段 ⑨ 还没标注的正文，两次判定看到的正文不同
    expect(gateOf('practice_boundary').order).toBeGreaterThan(gateOf('value_guard').order);
  });
});

describe('四、gate_report 的算术', () => {
  it('替换率只算 RATE_GATES，⑧ 的"补入"不进分子（把 ⑧ 加进 RATE_GATES → 红）', () => {
    const r = newGateReport();
    tallyGate(r, 'statute_guard', { seen: 100, fired: 1 });
    tallyGate(r, 'core_article_fallback', { seen: 3, fired: 3 });
    const sum = summarizeGateReport(r);
    expect(sum.seen).toBe(100);
    expect(sum.fired).toBe(1);
    expect(sum.replaceRate).toBeCloseTo(0.01);
    expect(sum.overBudget).toBe(false);
  });

  it('超预算就点名（预算被人调大 → 这条红，改预算必须有人来改判据）', () => {
    expect(REPLACE_RATE_BUDGET).toBe(0.02);
    const r = newGateReport();
    tallyGate(r, 'value_guard', { seen: 100, fired: 3 });
    expect(summarizeGateReport(r).overBudget).toBe(true);
  });

  it('同一道闸多次记账累加（正文通道 + 文书通道各记各的）', () => {
    const r = newGateReport();
    tallyGate(r, 'statute_guard', { seen: 4, fired: 1 });
    tallyGate(r, 'statute_guard', { seen: 2, fired: 1 });
    expect(r.gates.statute_guard).toEqual({ seen: 6, fired: 2 });
  });

  it('候选为 0 时两个率都是 0，不是 NaN 也不是 100%（除零会静默变成 NaN → 报表上一个空格）', () => {
    const sum = summarizeGateReport(newGateReport());
    expect(sum.replaceRate).toBe(0);
    expect(sum.leakRate).toBe(0);
    expect(sum.overBudget).toBe(false);
  });

  it('漏网数原样带进汇总，与替换率并列（只报一个 → 两个都读不出意思）', () => {
    const r = newGateReport();
    tallyGate(r, 'statute_guard', { seen: 10, fired: 0 });
    r.leaked = 2;
    const sum = summarizeGateReport(r);
    expect(sum.leaked).toBe(2);
    expect(sum.leakRate).toBeCloseTo(0.2);
  });

  it('RATE_GATES 恰是四道会做「替换」的闸（有人往里塞一道 observe 闸 → 红）', () => {
    expect([...RATE_GATES]).toEqual(['citation_guard', 'statute_guard', 'strip_unsupported_quotes', 'value_guard']);
    for (const id of RATE_GATES) expect(gateOf(id).effect).toBe('rewrite');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 五、端到端：闸真的接上了，不只是"源码里有它"
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么这一节必须存在】上面四节全部是纯函数与源码扫描。它们能证明"闸写对了"，
 * 证明不了"闸被调用了"——而**登记齐全、单测齐全、唯独没接线**在本仓真实发生过一次
 *（nbdpsyPitchAssertions，2026-08-26 评测官实证）。所以这里跑一整轮真编排，
 * 只问三件事：⑥ 标了没有、⑨ 标了没有、gate_report 无条件发了没有。
 */
describe('五、端到端接线', () => {
  const CARD = {
    name: 'action_card',
    args: { what: '把解除通知转发到个人邮箱', how: '公司邮箱 → 私人邮箱', why: '权限随时可能被停', due_at: '2026-08-27T18:00:00+08:00' },
  };

  /**
   * 跑一轮真编排。`opts.message` 换用户这一轮的原话（⑨ 的 `userTurns` 那份来源），
   * `opts.monthlyWageFen` 往档案里写月工资（⑨ 的 `caseFacts` 那份来源）——
   * 两份来源都只能从**编排**喂进闸，纯函数测试碰不到它们。
   */
  async function turn(
    script: { text: string; tools?: unknown[] }[],
    opts: { message?: string; monthlyWageFen?: number } = {},
  ) {
    const { makeAgentFixture, makeSink, scriptedProvider, fixtureSearcher, FIXTURE_PACK } = await import('./fixtures');
    const f = makeAgentFixture();
    if (opts.monthlyWageFen !== undefined) {
      f.db.prepare('UPDATE cases SET monthly_wage_fen = ? WHERE id = ?').run(opts.monthlyWageFen, f.caseId);
    }
    const sink = makeSink();
    const result = await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: opts.message ?? '我想知道能拿多少钱。',
      provider: scriptedProvider(script as never),
      searcher: fixtureSearcher([FIXTURE_PACK]),
      emit: sink.emit,
      now: new Date('2026-08-26T12:00:00Z'),
    });
    if (!('ok' in result) || !result.ok) throw new Error(`本轮未成功：${JSON.stringify(result)}`);
    const notices = sink.events.filter((e) => e.event === 'notice') as Extract<AgentEvent, { event: 'notice' }>[];
    const gateReport = notices.find((e) => e.data.code === 'GATE_REPORT')!.data.gate_report!;
    return { result, notices, gateReport };
  }

  it('⑥ 真的挂在流上：夹具卡里没有原文的条号，用户面拿到的是带标记的那一份', async () => {
    const { result, notices } = await turn([{ text: '依《某某某某法》第四十八条，你可以主张。', tools: [CARD] }]);
    expect(result.text).toContain(`第四十八条${UNVERIFIED_STATUTE}`);
    const n = notices.find((e) => e.data.code === 'STATUTE_UNVERIFIED');
    expect(n, '⑥ 开了火却没发自己的 notice').toBeTruthy();
    expect(n!.data.statute_marked?.[0]).toMatchObject({ verdict: 'unverified' });
    // 放行集挂在**无条件发**的 GATE_REPORT 上，不挂只在开火时发的这一条
    const g = notices.find((e) => e.data.code === 'GATE_REPORT');
    expect(g!.data.gate_report?.statute_allowed, '放行集没落盘 → 漏网率离线重算不出来').toBeDefined();
    // 禁令必配出路
    expect(n!.data.message).toContain('citation_check');
  });

  /**
   * 【干净轮也必须落盘放行集】(2026-09-08 复审 major) 挂在 ⑥ 自己那条 notice 上的形态是：
   * 模型全引对 → 不发 STATUTE_UNVERIFIED → 归档里没有放行集 → 判据读成空集 →
   * **用户面每一处真放行的条号都被判成漏网**，L1 在最理想的一轮恒红。
   */
  /**
   * 【⑤ 也必须配出路】(设计稿 §7.7) ⑥⑨ 的 notice 一直写着第一人称出路句，唯独 ⑤ 只说了
   *「已拦下、不作数」——用户读完知道这儿少了个案号，却不知道那个案子还找不找得回来、
   * 该跟我们说什么。这条钉住三样：说清发生了什么、给出路、给一句他回一句就能推进的话。
   *
   * 变异臂：把 message 改回只报"已拦下…不作数"（或去掉 suggest）⇒ 这条红。
   */
  it('⑤ 的 notice 带出路句与一键回复（只报"已拦下"→ 红）', async () => {
    const { result, notices } = await turn([
      { text: '参考（2023）京0105民初88888号的口径，你可以主张。', tools: [CARD] },
    ]);
    expect(result.text, '假案号必须在用户面被换成标记').toContain(UNVERIFIED_CITATION);
    const n = notices.find((e) => e.data.code === 'CITATION_BLOCKED');
    expect(n, '⑤ 开了火却没发自己的 notice').toBeTruthy();
    expect(n!.data.suggest, '没有 chip → 用户读完仍然不知道该说什么').toBeTruthy();
    expect(n!.data.message, '出路句里引的那句话要与 chip 逐字相同').toContain(`「${n!.data.suggest}」`);
    expect(n!.data.message, '要说清这一处现在长什么样').toContain(UNVERIFIED_CITATION);
  });

  it('干净轮（⑥ 一处都没标）照样落盘放行集（挂在无条件发的那条 notice 上）', async () => {
    const { notices } = await turn([{ text: '先把材料理一理，别急着签字。', tools: [CARD] }]);
    expect(notices.find((e) => e.data.code === 'STATUTE_UNVERIFIED'), '这一轮不该开火').toBeUndefined();
    const allowed = notices.find((e) => e.data.code === 'GATE_REPORT')!.data.gate_report!.statute_allowed;
    expect(allowed, '干净轮没有放行集 → 离线判据会把每一处放行都读成漏网').toBeDefined();
  });

  /**
   * 【⑨ 的上线口径是**观察模式**（manager 2026-09-08 裁定，见 gate-chain.ts 的 VALUE_GUARD_MODE）】
   * 它的标记是写进用户面的：一处误伤就是在一个算对了的数旁边写上【数值无来源】。
   * 而这道闸的误标率至今只在合成样本与真库语料上量过，没有一条真模型跑批的读数——
   * 所以先只记账（notice + gate_report），正文一个字不动，等误标率 < 2% 再切 `rewrite`。
   *
   * 这一条钉的是**观察那一臂**：闸照常开火、照常记账、**正文里一个标记都没有**。
   * 把 orchestrator 里那行改回无条件赋值（"忘了模式"）→ 红。
   */
  it('⑨ 真的挂在出口，且观察模式下只记账不改正文（改了正文 → 红）', async () => {
    expect(VALUE_GUARD_MODE, '这条判据钉的是 observe 这一臂；切到 rewrite 要连它一起改').toBe('observe');
    const { result, notices, gateReport } = await turn([{ text: '这一项一般封顶 60 万，可以谈。', tools: [CARD] }]);
    expect(result.text, '观察模式下正文必须逐字原样').toBe('这一项一般封顶 60 万，可以谈。');
    expect(result.text).not.toContain(VALUE_UNSOURCED);
    // 但闸确实开了火：notice 逐条点名 + gate_report 照常进替换率的分子
    const n = notices.find((e) => e.data.code === 'VALUE_UNSOURCED');
    expect(n, '⑨ 开了火却没发自己的 notice').toBeTruthy();
    expect(n!.data.message).toContain('claim_calc');
    expect(n!.data.value_marked?.[0]).toMatchObject({ token: '60 万', kind: '金额', mark: 'unsourced' });
    expect(gateReport.gates.value_guard).toEqual({ seen: 1, fired: 1 });
    // 观察模式下这句话不许说「已标注」——正文里没有那个标记，用户会去找而找不到
    expect(n!.data.message, '留痕说了一件没发生的事').not.toContain('已标注');
  });

  /**
   * 【另一臂：`rewrite` 时行为同现在】切换只改 gate-chain.ts 里的一个字，
   * 而"改对了没有"必须在切换**之前**就有判据——否则那天上线靠的是读一遍代码。
   * 两臂都在这里，翻转 `valueGuardText` 的任一分支当场红。
   */
  it('⑨ 的两臂：observe 交出原文、rewrite 交出标注后的正文（把三元反过来 → 红）', () => {
    const raw = '这一项一般封顶 60 万。';
    const marked = `这一项一般封顶 60 万${VALUE_UNSOURCED}。`;
    expect(valueGuardText('observe', raw, marked)).toBe(raw);
    expect(valueGuardText('rewrite', raw, marked)).toBe(marked);
  });

  it('gate_report **无条件**发（一处都没动的干净轮也要发；只在非空时发 = 把"跑了没动"与"不知道"抹成一件事）', async () => {
    const { notices } = await turn([{ text: '先把材料理一理，别急着签字。', tools: [CARD] }]);
    const n = notices.find((e) => e.data.code === 'GATE_REPORT');
    expect(n, '干净轮没有 gate_report').toBeTruthy();
    const r = n!.data.gate_report!;
    expect(r.fired).toBe(0);
    expect(r.leaked, '漏网结构上恒 0').toBe(0);
    expect(r.budget).toBe(REPLACE_RATE_BUDGET);
    expect(r.over_budget).toBe(false);
    // 逐闸分账在场：只报总数就查不出是哪一道在动手
    expect(Object.keys(r.gates)).toContain('statute_guard');
  });

  /**
   * 【接线判据：工具轮里检索回来的卡也必须进放行集】
   *
   * 删掉 `runOnce` 里那行 `statutes.allowFrom(state.retrieved)`，形态是：
   * 模型这一轮刚 `knowledge_search` 取回 §46 的原文、下一句逐字引用它，
   * 闸把它标成【条号待核验】——**闸在惩罚模型做对的事**。
   * 而纯函数测试看不见这个（它测的是闸，不是编排），所以这一条必须跑真编排。
   */
  it('工具轮里检索回来的卡也进放行集（删掉 runOnce 里的 statutes.allowFrom → 红）', async () => {
    const { makeAgentFixture, makeSink, scriptedProvider, FIXTURE_PACK } = await import('./fixtures');
    const withQuote: KnowledgePack = {
      ...FIXTURE_PACK,
      id: 'statute-fake-46',
      facts: { statute_quotes: [{ law: '某某某某法', article: '第四十六条', text: '有下列情形之一的，应当支付经济补偿' }] },
    };
    const f = makeAgentFixture();
    const sink = makeSink();
    const result = await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '这条依据是什么？',
      provider: scriptedProvider([
        // 轮1：先检索（此时放行集里还没有 §46）
        { text: '我先查一下依据。', tools: [{ name: 'knowledge_search', args: { query: '经济补偿' } }] },
        // 轮2：引用刚查回来的那一条
        { text: '依《某某某某法》第四十六条，你可以主张。', tools: [CARD] },
      ] as never),
      // 预检索给空包，让 §46 **只能**从工具轮进来——否则构造时那次 allowFrom 就把它收了，
      // 这条判据会变成恒真（它验的是"中途扩充"，不是"构造时收过"）
      searcher: { search: (q: string) => (q.includes('经济补偿') ? [withQuote] : []), get: () => undefined },
      emit: sink.emit,
      now: new Date('2026-08-26T12:00:00Z'),
    });
    if (!('ok' in result) || !result.ok) throw new Error(`本轮未成功：${JSON.stringify(result)}`);
    expect(result.text, '刚检索回来的条被闸标掉了 → 放行集没有中途扩充').not.toContain(UNVERIFIED_STATUTE);
    expect(result.text).toContain('第四十六条');
  });

  /**
   * 【接线判据：**核心条映射定向注入**的那张卡也必须在 ⑥ 的放行集里（2026-09-08 复审 major）】
   *
   * statute-guard.ts 的文件头写着放行集的第二项是「核心条映射命中且已取到原文的条」，
   * 并声明它是第一项的子集——"这不是巧合、也不该靠巧合"。而在此之前，**没有一条判据
   * 跑过这条路**：上面那条工具轮判据走的是 `knowledge_search`，⑥⑧ 那条交互用例是纯函数，
   * 两条都碰不到 S3b 那段定向注入（`findByArticleKeys` → `packs.push`）。
   *
   * 它守的形态是首诊最主流的一轮：预检索一张法条卡都没捞到（4e10b7c 批三跑实测），
   * 映射表声明本场景的核心条是 §46，系统主动把那张卡送到模型面前——
   * 模型照着引了，而 ⑥ 把它标成【条号待核验】。**闸在惩罚系统自己刚送进去的料**，
   * 且 ⑧ 紧接着会给一个刚被标掉的位置补原文，两道闸在同一处各说各的。
   */
  describe('核心条映射定向注入的卡进放行集（allowFrom 漏掉 injectedCoreCards → 红）', () => {
    /** 本场景（夹具的 stage = 已收通知）声明的核心条只有一条，好让 findByArticleKeys 的取到/取不到成为唯一变量 */
    const MAP_PACK: KnowledgePack = {
      ...statutePack([]),
      id: CORE_ARTICLE_MAP_PACK_ID,
      type: '方法卡',
      title: '场景 → 核心依据条映射',
      facts: { core_article_map: [{ scene: '已收通知', articles: ['劳动合同法|第46条'] }] },
    };
    /** 定向注入要取的那张卡。**只有它带 statute_quotes** */
    const CORE_CARD: KnowledgePack = {
      ...statutePack([
        {
          law: '劳动合同法',
          article: '第四十六条',
          text: '有下列情形之一的，用人单位应当向劳动者支付经济补偿：（一）劳动者依照本法第三十八条规定解除劳动合同的；',
        },
      ]),
      id: 'statute-lhtf-46',
    };
    /** 预检索捞到的：一张不带逐字条文的卡 ⇒ ⭐候选为空 ⇒ S3b 定向注入才会触发 */
    const NO_STATUTE: KnowledgePack = { ...statutePack([]), id: 'script-anytalk', type: '话术卡', title: '话术卡', facts: {} };
    /** 核心位（`应当向劳动者支付` 命中结论标记）+ 光秃条号 ⇒ ⑧ 该在这里补原文 */
    const LINE = '公司应当向劳动者支付经济补偿，依据是《劳动合同法》第四十六条。';

    async function run(findByArticleKeys: (keys: string[]) => KnowledgePack[]) {
      const { makeAgentFixture, makeSink, scriptedProvider } = await import('./fixtures');
      const f = makeAgentFixture();
      const sink = makeSink();
      const result = await runTurn({
        db: f.db,
        caseId: f.caseId,
        userId: f.userId,
        message: '我想知道能拿多少钱。',
        provider: scriptedProvider([{ text: LINE, tools: [CARD] }] as never),
        searcher: {
          search: () => [NO_STATUTE],
          get: (id: string) => (id === CORE_ARTICLE_MAP_PACK_ID ? MAP_PACK : undefined),
          findByArticleKeys,
        },
        emit: sink.emit,
        now: new Date('2026-08-26T12:00:00Z'),
      });
      if (!('ok' in result) || !result.ok) throw new Error(`本轮未成功：${JSON.stringify(result)}`);
      const notices = sink.events.filter((e) => e.event === 'notice') as Extract<AgentEvent, { event: 'notice' }>[];
      return { result, notices, gateReport: notices.find((e) => e.data.code === 'GATE_REPORT')!.data.gate_report! };
    }

    it('取到了：⑥ 不标、⑧ 就地补原文、放行集里有这一条、漏网 0', async () => {
      const { result, gateReport } = await run((keys) => (keys.includes('劳动合同法|第46条') ? [CORE_CARD] : []));
      expect(result.text, '系统自己送进来的核心条被闸标成【条号待核验】').not.toContain(UNVERIFIED_STATUTE);
      expect(result.text, '⑧ 没在核心位补上卡内逐字原文').toContain('第四十六条「');
      expect(result.text).toContain('用人单位应当向劳动者支付经济补偿');
      expect(gateReport.statute_allowed, '放行集里没有定向注入进来的那一条').toContain('劳动合同法|第46条');
      expect(gateReport.leaked, '⑧ 补进来的原文里那句交叉引用被记成 ⑥ 的漏网').toBe(0);
    });

    it('负对照：同一条路上 findByArticleKeys 取不到 → 照标（否则上面那条可能只是闸整个关掉了）', async () => {
      const { result, gateReport } = await run(() => []);
      expect(result.text).toContain(`第四十六条${UNVERIFIED_STATUTE}`);
      expect(gateReport.statute_allowed).not.toContain('劳动合同法|第46条');
    });
  });

  /**
   * 【⑨ 的三份放行来源，每份一条**真编排**判据（2026-09-08 复审 major）】
   *
   * 这三份来源（本轮算出来的数 / 档案里的结构化事实 / 用户自己说过的话）都不是闸自己能取的，
   * 全靠 orchestrator 在调用点喂进去。此前它们**只有闸内部的单测**：
   * 删掉 `tools.ts` 里那行 `ctx.state.calcPayloads.push(res.payload)`，
   * 或把 orchestrator 里的 `caseFacts` / `userTurns` 喂成空数组——
   * agent 全套加 scripts/eval 一千四百多条判据**全绿**。
   * 形态是「登记齐全、单测齐全、唯独没接线」，本仓 08-26 已经实证发生过一次。
   *
   * 三条各带一个负对照：同一轮里换一个没人给过的数，闸照样开火——
   * 否则"放行"这件事可以由"闸整个坏了"来解释，判据就成了恒真。
   */
  describe('⑨ 的三份放行来源各有一条接线判据', () => {
    /** ⑨ 这一轮点名了哪几个数值 token（观察模式下正文不变，开没开火只能从 notice 读） */
    const fired = (notices: Extract<AgentEvent, { event: 'notice' }>[]) =>
      notices.find((e) => e.data.code === 'VALUE_UNSOURCED')?.data.value_marked?.map((v) => v.token) ?? [];

    /** 一次会算出 142500.00 元的 claim_calc（19000 元/月 × 7.5 年，见 record 的 claims_upsert 摘要） */
    const CALC_CALL = {
      name: 'claim_calc',
      args: { kind: 'N', avg_monthly_wage_fen: 1_900_000, employed_from: '2019-03-01', terminated_at: '2026-08-19' },
    };

    it('① 算完再复述：逐字的「142500 元」放行（删掉 tools.ts 里的 calcPayloads.push → 红）', async () => {
      const { result, gateReport } = await turn([
        { text: '我先算一下。', tools: [CALC_CALL] },
        { text: '算下来是 142500 元。', tools: [CARD] },
      ]);
      // **逐字比整句**，不是只查有没有【数值无来源】：⑨ 有两种标记，
      // 只查其中一种的形态是——闸把它判成【数值与来源卡不一致】，判据照样绿。
      expect(result.text, '刚算出来的数被标了 → 出参没进放行集').toContain('算下来是 142500 元。');
      expect(gateReport.gates.value_guard).toEqual({ seen: 1, fired: 0 });
    });

    it('① 约写同样放行：「约 14.3 万元」是 142500 的四舍五入（约写只喂卡里的数 → 红）', async () => {
      const { result, gateReport } = await turn([
        { text: '我先算一下。', tools: [CALC_CALL] },
        { text: '算下来大概 14.3 万元。', tools: [CARD] },
      ]);
      expect(result.text, 'charter 的主路：模型复述刚算完的数时几乎总要约写').toContain('算下来大概 14.3 万元。');
      // 约写没接上时它会落进 ±0.5% 容差 →【数值与来源卡不一致】而不是【数值无来源】：
      // 对用户仍然是"你抄错了"，而他抄对了。所以这里比的是 fired，不是某一种标记
      expect(gateReport.gates.value_guard).toEqual({ seen: 1, fired: 0 });
    });

    /**
      * 三条负对照读的是 **notice + gate_report**，不是正文里的标记：⑨ 现在是观察模式
      *（gate-chain.ts 的 VALUE_GUARD_MODE），正文本来就不会变。查正文的形态是——
      * 切回 rewrite 那天这三条才有意义，而在观察期它们恒绿，等于三条恒真的判据。
      */
    it('① 负对照：同一轮里没人算过的「60 万」照样开火（否则上面两条可能只是闸坏了）', async () => {
      const { result, notices, gateReport } = await turn([
        { text: '我先算一下。', tools: [CALC_CALL] },
        { text: '算下来是 142500 元，不过一般能谈到 60 万。', tools: [CARD] },
      ]);
      expect(fired(notices)).toEqual(['60 万']);
      expect(gateReport.gates.value_guard).toEqual({ seen: 2, fired: 1 });
      expect(result.text).toContain('142500 元，');
    });

    it('② 档案事实：复述档案里的月工资放行（orchestrator 的 caseFacts 喂空数组 → 红）', async () => {
      const { result, gateReport } = await turn([{ text: '你月薪 20000 元，先记住这个数。', tools: [CARD] }], {
        monthlyWageFen: 2_000_000,
      });
      expect(result.text, '用户自己填进档案的工资被判成编造').toContain('你月薪 20000 元，先记住这个数。');
      expect(gateReport.gates.value_guard).toEqual({ seen: 1, fired: 0 });
    });

    it('② 负对照：档案里没有的那个数照样开火（把 caseFacts 当"有档案就全放行" → 红）', async () => {
      const { result, notices, gateReport } = await turn([{ text: '你月薪 20000 元，赔偿大概 60 万。', tools: [CARD] }], {
        monthlyWageFen: 2_000_000,
      });
      expect(fired(notices)).toEqual(['60 万']);
      expect(gateReport.gates.value_guard).toEqual({ seen: 2, fired: 1 });
      expect(result.text).toContain('你月薪 20000 元，');
    });

    it('③ 用户原话：复述他自己说过的数放行（orchestrator 的 userTurns 喂空数组 → 红）', async () => {
      const { result, gateReport } = await turn([{ text: '你说月薪 2 万，先把这件事记下来。', tools: [CARD] }], {
        message: '我月薪 2 万，公司说要裁员。',
      });
      expect(result.text, '系统在质疑用户对自己的事的陈述').toContain('你说月薪 2 万，先把这件事记下来。');
      expect(gateReport.gates.value_guard).toEqual({ seen: 1, fired: 0 });
    });

    it('③ 负对照：用户没说过的数照样开火（把 userTurns 当"有原话就全放行" → 红）', async () => {
      const { result, notices, gateReport } = await turn([{ text: '你说月薪 2 万，大概能拿 60 万。', tools: [CARD] }], {
        message: '我月薪 2 万，公司说要裁员。',
      });
      expect(fired(notices)).toEqual(['60 万']);
      expect(gateReport.gates.value_guard).toEqual({ seen: 2, fired: 1 });
      expect(result.text).toContain('你说月薪 2 万，');
    });
  });

  /**
   * 【漏网这一列必须读真正文（2026-09-08 复审 minor）】把 orchestrator 里那行
   * `statutes.leakedIn(text)` 换成 `[]`，全套 41 个文件 1476 条判据全绿——
   * 成绩单上的漏网率从此恒 0，而**恒 0 的量正是靠"它不是 0 的那一天"才有意义的**。
   *
   * 这一轮真的会漏一处，而且漏在**免检态判错**上（`leaked` 的定性就是它）：
   * 流上一见 `第N条　` 那个全角空格就把整行免检（它逐片跑，看不见这一行后面有多长），
   * 而自检的 `insideOwnFormatQuote` 要求自家格式的正文 ≥10 字才算原文。
   * 真语料里注入块的正文都远超 10 字，所以这个口径差只在模型自造一行极短的自家格式时露头
   * ——它露的头正好是这条判据要的那一处：闸没标、自检报得出来。
   */
  it('漏网数来自对真正文的复查（把 leakedIn 的调用换成 [] → 红）', async () => {
    const { result, notices, gateReport } = await turn([{ text: '第九十九条　第四十八条', tools: [CARD] }]);
    // 打头那条判了、标了；同一行后半截那条落在流上的免检区里，没标
    expect(result.text).toContain(`第九十九条${UNVERIFIED_STATUTE}`);
    expect(result.text).toContain('　第四十八条');
    expect(result.text).not.toContain(`第四十八条${UNVERIFIED_STATUTE}`);
    expect(gateReport.leaked, '自检没数出这一处 → 漏网率这一列在成绩单上恒 0').toBe(1);
    expect(gateReport.leak_rate).toBeGreaterThan(0);
    // 漏了哪一处也要写进消息里：只报一个数，读的人没法去查
    expect(notices.find((e) => e.data.code === 'GATE_REPORT')!.data.message).toContain('第四十八条');
  });

  it('开火轮的 gate_report 分子分母都对得上（分母恒 0 会让替换率永远报 0%）', async () => {
    const { notices } = await turn([{ text: '依《某某某某法》第四十八条，封顶 60 万。', tools: [CARD] }]);
    const r = notices.find((e) => e.data.code === 'GATE_REPORT')!.data.gate_report!;
    expect(r.gates.statute_guard).toEqual({ seen: 1, fired: 1 });
    expect(r.gates.value_guard).toEqual({ seen: 1, fired: 1 });
    expect(r.seen).toBeGreaterThanOrEqual(2);
    expect(r.fired).toBe(2);
    expect(r.leaked).toBe(0);
  });
});
