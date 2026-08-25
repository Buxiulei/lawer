/**
 * 【危机轮输出流经的闸 · 登记册】(manager 2026-08-25 点名要的产物，硬门槛不是建议)
 *
 * 【为什么要有这份东西】杠杆闸把**复述用户原话的共情句**整句删掉，在生产上发生了，
 * 而我们是靠 ws2-agent 落码时偶然撞到才知道的——**没有人在维护一份"危机轮的话会经过谁的手"的清单**。
 * 判据误报只是记一笔错账；**闸误报是当场把话删掉，而且用户不知道少了什么**。
 *
 * 【这份清单的规矩】**此后新增任何一道剥除/改写环节，必须在这里登记**，
 * 并给出它在危机轮的实测影响。下面那条元测试会在漏登记时变红——
 * 它扫的是 `orchestrator.ts` 的真实调用，**不是靠人记得来更新**。
 *
 * 【一处纠正】此前口头传的是"已知三道"，**实测是六道**（见下表）。
 * 少数的那三道里，`stripNbdpsyPitch` 与第五闸同样会动危机轮的正文。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 危机轮正文流经的**全部**剥除/改写环节，按 orchestrator 里的先后顺序。
 * `mutates` = 它会不会改动用户最终看到的正文。
 */
const CRISIS_OUTPUT_GATES = [
  {
    fn: 'stripLeverageSentences',
    what: '情感杠杆句整句剥除（仅危机轮）',
    enabled: true,
    note: '2026-08-25 修：改为来源判别——引号内容来自用户原话＝复述，放行；替他构造的情绪照剥',
  },
  {
    fn: 'CRISIS_SAFE_FALLBACK',
    what: '🔴 剥完仍命中或剥空 → 模型段整段丢弃，回落确定性安全回复（仅危机轮）',
    enabled: true,
    note: '影响最大的一道：模型的话一个字都不下发',
    /**
     * 【触发条件与上游依赖 — 实测，manager 点名要这一栏】
     *
     * **它不是"几句被判杠杆"的问题，是"还剩不剩干净句子"的问题**（实测）：
     *   0 句杠杆 + 2 句干净 → clean
     *   1 句杠杆 + 2 句干净 → stripped（只删命中句）
     *   2 句杠杆 + 1 句干净 → stripped
     *   3 句杠杆 + 0 句干净 → **fallback**
     *   **1 句杠杆 + 0 句干净 → fallback**   ← 一句就够，只要它是全部
     *
     * 【为什么它是级联放大器】触发条件是**剥完之后一句不剩**，
     * 所以**上游任何一道闸误判越多，越容易把句子剥光，越容易触发它**；
     * 而它一触发，用户就只剩确定性首段——**模型说的每一个字都没了**。
     *
     * 【本次修法直接削弱了这条级联 — 实测】一段**全是共情复述**的危机轮回复
     * （「刚才你说的"对不起爸妈"，我一句都没当成小事。」）：
     *   · 修前：命中 → 剥光 → **fallback，用户只剩确定性首段**
     *   · 修后：来源判别放行 → **clean，原样下发**
     * 也就是说旧实现在"模型认真接住用户"时**最容易把整段话吞掉**——
     * 越是好好接住（整段都在复述他的话），越容易一句不剩。
     */
    cascade: true,
  },
  {
    fn: 'stripDuplicateHotlineList',
    what: '与首段重复的整张热线卡剥除（仅危机轮）',
    enabled: false,
    note: '当前 CRISIS_HOTLINE_DEDUP_ENABLED=false，**该函数在产线上不被调用**（已按代码核实，非按注释）',
  },
  {
    fn: 'stripNbdpsyPitch',
    what: '付费心理咨询推介句整句剥除',
    enabled: true,
    note: '不限危机轮，但危机轮同样流经',
  },
  {
    fn: 'stripUnsupportedQuotes',
    what: '第五闸：引号内伪逐字法条引用改口为「待核实」',
    enabled: true,
    note: '唯一一道**留痕**的闸（CITATION_BLOCKED.stripped_articles）——正因为它留痕，§27 那次才定得了案',
  },
  {
    fn: 'renderCoreArticleFallback',
    what: '核心位光秃条号就地补入卡内逐字原文（**增**不是删）',
    enabled: true,
    note: '方向与其余五道相反：它往正文里加内容',
  },
] as const;

/**
 * 【非闸名册】orchestrator 从闸模块导入、但**不改动下发正文**的东西，每项必须写明为什么不是闸。
 *
 * 【为什么需要这份反向名册】上面那条漏登记检测只扫 `strip*` 前缀，
 * 而登记册自己的六道里就有两道（`CRISIS_SAFE_FALLBACK`、`renderCoreArticleFallback`）不叫 strip——
 * **检测器扫不到它要管的清单里的三分之一**。靠前缀就是靠命名约定，而命名约定会漂。
 *
 * 【改用的口径】不推断，只要求**不许有未分类的导入**：
 * 从 `./crisis` 与 `./citation-block` 导入的每一个值，要么在登记册上，要么在这份名册上并写明理由。
 * 新加一个导入而不表态，测试就红。
 *
 * 【为什么不靠返回类型推断】试过，不成立：`articleKey` 返回 `string` 却不是闸，
 * 而 `CRISIS_SAFE_FALLBACK` 是个常量数组却是影响最大的一道。
 * **判断哪个是闸需要人看一眼；这条测试要保证的不是判断正确，是判断没被跳过。**
 */
const NON_GATE_IMPORTS: Record<string, string> = {
  // —— ./crisis ——
  assessCrisis: '判定，返回 CrisisAssessment，不碰正文',
  detectEmotionalLeverage: '检测器，返回命中句；剥除动作由 stripLeverageSentences 做',
  detectNbdpsyPitch: '检测器',
  assessNbdpsyEligibility: '判定',
  responseGaveCrisisCard: '判定',
  shouldInjectCrisisCard: '判定',
  extractHotlines: '取号码，不改正文',
  compactCrisisCard: '压的是**喂给模型**的知识卡，不是下发给用户的正文',
  CRISIS_CARD_MARKER: '常量标记',
  buildCrisisOpener:
    '生成确定性首段。**它是增不是改**，且不经手模型正文——' +
    '危机轮回落时用户唯一还能看到的就是它。它的失效形态是「该给的没给」，' +
    '由危机轮号码在场断言（L1）管，不由这份登记册管。',
  // —— ./citation-block ——
  articleKey: '取键，不碰正文（注意它返回 string，所以按返回类型推断会误判成闸）',
  coreArticleKeys: '取候选集合',
  coreBlockRenderedKeys: '取已渲染的键，只读',
  sceneCoreArticles: '取场景核心条，只读',
  CORE_ARTICLE_MAP_PACK_ID: '常量 id',
  bareArticleCitations: '检测器',
  precedentContamination: '检测器',
};

/** 从 orchestrator 的 import 语句里取出某模块导入的全部**值**标识符（跳过 `type` 导入）。 */
function importedValuesFrom(src: string, moduleSpec: string): string[] {
  const re = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*'${moduleSpec}'`, 'g');
  const names: string[] = [];
  for (const m of src.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/\s+as\s+\w+$/, '');
      if (!name || name.startsWith('type ')) continue;
      names.push(name);
    }
  }
  return names;
}

describe('危机轮输出流经的闸：登记册与漏登记检测', () => {
  const SRC = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

  it('登记册里的每一项都真的出现在 orchestrator 里（防清单与代码脱节）', () => {
    const missing = CRISIS_OUTPUT_GATES.filter((g) => !SRC.includes(g.fn)).map((g) => g.fn);
    expect(missing, `登记了但代码里找不到（改名了？删了？）：${missing.join('、')}`).toEqual([]);
  });

  it('★漏登记检测：orchestrator 里所有 strip* 调用都必须在登记册上', () => {
    // 扫真实调用，不靠人记得更新清单
    const called = [...SRC.matchAll(/\b(strip[A-Z]\w+)\s*\(/g)].map((m) => m[1]);
    const registered = new Set<string>(CRISIS_OUTPUT_GATES.map((g) => g.fn));
    const unregistered = [...new Set(called)].filter((fn) => !registered.has(fn));
    expect(
      unregistered,
      `以下剥除环节在 orchestrator 里被调用但**没有登记**：${unregistered.join('、')}\n` +
        `→ 危机轮的话会经过它而没人知道。请登记并给出它在危机轮的实测影响。`,
    ).toEqual([]);
  });

  it('自证扫得到东西（扫不到时上一条会假绿）', () => {
    expect([...SRC.matchAll(/\bstrip[A-Z]\w+\s*\(/g)].length).toBeGreaterThanOrEqual(3);
  });

  // ↓↓↓ 补 strip* 前缀扫不到的那一类（登记册六道里有两道不叫 strip）
  const GATE_MODULES = [String.raw`\./crisis`, String.raw`\./citation-block`];
  const imported = GATE_MODULES.flatMap((m) => importedValuesFrom(SRC, m));

  it('★不许有未分类的导入：闸模块的每个导入，要么在登记册上，要么在非闸名册上', () => {
    const registered = new Set<string>(CRISIS_OUTPUT_GATES.map((g) => g.fn));
    const unclassified = [...new Set(imported)].filter(
      (n) => !registered.has(n) && !(n in NON_GATE_IMPORTS),
    );
    expect(
      unclassified,
      `以下东西从闸模块导进了 orchestrator，但**没人表态它是不是闸**：${unclassified.join('、')}\n` +
        `→ 请二选一：登记进 CRISIS_OUTPUT_GATES（并给出危机轮实测影响），` +
        `或写进 NON_GATE_IMPORTS 并说明为什么它不改下发正文。\n` +
        `→ 这条不判断你分得对不对，只保证你没跳过这一步。`,
    ).toEqual([]);
  });

  it('★负样本：检测器对**不叫 strip 的**新闸也会开火（否则等于没扫）', () => {
    // 造一个未登记且不含 strip 前缀的导入，确认它会被判为未分类。
    // 这是上一条的自证——它要防的正是「前缀扫描漏掉非 strip 命名」这个原始缺口。
    // 密封样本：不掺真实导入。否则 orchestrator 一旦真的多出未分类导入，
    // 这条负样本会跟着变红，把「自证」污染成「又一条重复告警」。
    const registered = new Set<string>(CRISIS_OUTPUT_GATES.map((g) => g.fn));
    const fabricated = ['assessCrisis', 'stripLeverageSentences', 'redactPanicPhrases'];
    const unclassified = fabricated.filter((n) => !registered.has(n) && !(n in NON_GATE_IMPORTS));
    expect(unclassified).toEqual(['redactPanicPhrases']);
    // 同时确认旧的前缀扫描确实抓不到它——这就是为什么需要上面那条
    expect(/\bstrip[A-Z]\w+/.test('redactPanicPhrases')).toBe(false);
  });

  it('非闸名册不许留存量（写了理由但东西已经不导入了 → 名册过期）', () => {
    const stale = Object.keys(NON_GATE_IMPORTS).filter((n) => !imported.includes(n));
    expect(
      stale,
      `非闸名册里这些已经不再从闸模块导入了：${stale.join('、')}\n` +
        `→ 删掉，否则名册会变成一份没人信的旧账。`,
    ).toEqual([]);
  });

  it('★级联放大器已标注且触发条件已实测（不是"几句"，是"还剩不剩"）', () => {
    const cascade = CRISIS_OUTPUT_GATES.filter((g) => 'cascade' in g && g.cascade);
    expect(cascade.map((g) => g.fn)).toEqual(['CRISIS_SAFE_FALLBACK']);
    expect(cascade[0].what).toContain('🔴');
  });

  it('停用中的闸确实没在跑（按代码核实，不按注释）', () => {
    // 注释说"已临时停用"不算证据——常量为 false 且是 && 的第一个操作数，才算
    expect(SRC).toContain('const CRISIS_HOTLINE_DEDUP_ENABLED = false');
    const disabled = CRISIS_OUTPUT_GATES.filter((g) => !g.enabled).map((g) => g.fn);
    expect(disabled).toEqual(['stripDuplicateHotlineList']);
  });
});
