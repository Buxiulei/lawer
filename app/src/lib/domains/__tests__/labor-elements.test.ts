// app/src/lib/domains/__tests__/labor-elements.test.ts
// **要件卡的依据核验**（S6 判据一）。
//
// 【这份判据在守什么】主理人 2026-09-07 裁决③：本产品没有律师签字，要件卡的内容由 AI 推导。
// 推导可以错，能兜住它的只有一件事——**每一条依据都指到一份逐字核过的官方原文**。
// 所以这里逐条问三个问题，缺一个即红：
//   ① 这个锚点在知识库里**找得到**吗（`法名|条号` 归一后能对上某张卡的 statute_quotes）？
//   ② 那张卡的可信度是「原文核实」吗？
//   ③ 那条引文与登记簿里的**官方原件**逐字一致吗？
//
// 【为什么第③问要去跑 verify-quotes.py，而不是在 TS 里再写一把尺】"逐字一致"的归一口径
// （NFKC、去空白与 markdown 记号、引号字形不折）已经有一份正本在 scripts/knowledge_sources.py，
// 而 gen-knowledge-index.py 与 verify-quotes.py 共用它。这里再写一把 TS 的尺，
// 就有了第三份——它会在某次口径微调之后与那两份分叉，而**分叉的表现是这条判据变绿**
// （宽一点的尺照样报一致）。跑同一个脚本、读它的 JSON，是唯一没有第二把尺的做法。
//
// 【变异矩阵】每条断言的失败方式都写在它的标题里，逐条可人工制造：
//   · 把某条 basis 的条号改成一个库里没有的（如「第九十九条」）⇒ ① 红；
//   · 把某张法条卡的 confidence 改成「二手转述」⇒ ② 红；
//   · 把卡里某条 statute_quotes 的 text 改一个字 ⇒ ③ 红；
//   · 把某个要件的 burden 从 reversed_procedure_rules 改成 reversed_interpretation
//     而 basis 里没有那条限定条 ⇒ 「两条规则不许互相顶替」红；
//   · 删掉某张卡的 typicalEvidence ⇒ 装载期 assertDomainPack 红（见 registry-contract）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { articleKey } from '@/lib/agent/citation-block';
import { BURDENS, type Burden } from '@/lib/cases/elements';

import { LABOR } from '../labor';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const INDEX_JSON = `${REPO_ROOT}knowledge/index.json`;
const VERIFY_SCRIPT = `${REPO_ROOT}scripts/verify-quotes.py`;

interface IndexCard {
  id: string;
  confidence: string;
  facts?: { statute_quotes?: { law: string; article: string; source_id?: string; text: string }[] };
}

const CARDS: IndexCard[] = JSON.parse(fs.readFileSync(INDEX_JSON, 'utf-8'));

/**
 * 锚点串（`法名|条号`，条号写的是中文原样）→ 归一键。
 *
 * 【为什么卡片里写中文条号而不直接写归一键】卡片是给人读、给人改的：`劳动合同法|第四十七条`
 * 一眼看得出是哪一条，`劳动合同法|第47条` 也行、但**归一键的形态会随 normalizeArticle 变**
 *（它现在把「第四十七条之一」拆成独立键）。把归一后的串写进领域包，等于把一个内部实现
 * 抄进了内容层，某次归一口径调整之后两边静默分叉。所以内容层写人话，比对时经这一个函数。
 */
const keyOf = (anchor: string): string => {
  const at = anchor.indexOf('|');
  return at <= 0 ? anchor : articleKey(anchor.slice(0, at), anchor.slice(at + 1));
};

/** `法名|条号` → 提到它的那几张卡。卡侧与要件侧**走同一个 articleKey**，不各自归一。 */
const BY_ANCHOR = new Map<string, IndexCard[]>();
for (const card of CARDS) {
  for (const q of card.facts?.statute_quotes ?? []) {
    const key = articleKey(q.law, q.article);
    BY_ANCHOR.set(key, [...(BY_ANCHOR.get(key) ?? []), card]);
  }
}

/**
 * `verify-quotes.py --json` 的逐条核验状态：`法名|条号` → 这一条的 state 集合。
 *
 * **跑不起来就让判据失败，不 skip**：skip 掉的形态是——CI 上 python 缺一个包，
 * 这条判据从此每次都"通过"（skip 在汇总里与 pass 一起显示为绿），
 * 而它守的正是"依据到底核没核过"这件事。
 */
const VERIFY_STATE = (() => {
  const raw = execFileSync('python3', [VERIFY_SCRIPT, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as {
    rows: { law: string; article: string; state: string; card_id: string }[];
  };
  const byKey = new Map<string, Set<string>>();
  for (const row of parsed.rows) {
    const key = articleKey(row.law, row.article);
    byKey.set(key, (byKey.get(key) ?? new Set()).add(row.state));
  }
  return byKey;
})();

const CARDS_BY_KIND = new Map<string, typeof LABOR.elementCards>();
for (const card of LABOR.elementCards ?? []) {
  CARDS_BY_KIND.set(card.claimKind, [...(CARDS_BY_KIND.get(card.claimKind) ?? []), card] as never);
}

/** 本片要覆盖的四项诉求（派单点名）。多一项少一项都要有人来改这一行。 */
const COVERED_KINDS = ['2N', 'N', '欠薪', '双倍工资'];

/** 「限定事项倒置」那一条的锚点：司法解释（一）第四十四条。 */
const INTERPRETATION_ANCHOR = articleKey('最高人民法院关于审理劳动争议案件适用法律问题的解释（一）', '第四十四条');
/** 「证据偏在」那两条的锚点：调解仲裁法第六条 / 仲裁办案规则第十三条。 */
const PROCEDURE_ANCHORS = [
  articleKey('中华人民共和国劳动争议调解仲裁法', '第六条'),
  articleKey('劳动人事争议仲裁办案规则', '第十三条'),
];

describe('要件卡：结构与覆盖', () => {
  it('🔒 地板：卡是有的、锚点是有的（空清单会让下面每一条永远绿）', () => {
    expect(LABOR.elementCards?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(BY_ANCHOR.size).toBeGreaterThan(50);
    expect(VERIFY_STATE.size).toBeGreaterThan(50);
    expect(LABOR.burdenLabels).toBeTruthy();
    expect(LABOR.elementSheetTitle).toBeTruthy();
  });

  it('四项诉求各自都有要件，且每个 claimKind 都在本包 claimKinds 里', () => {
    for (const kind of COVERED_KINDS) {
      expect(CARDS_BY_KIND.get(kind)?.length ?? 0, `${kind} 一个要件都没有`).toBeGreaterThanOrEqual(4);
    }
    for (const card of LABOR.elementCards ?? []) {
      expect(LABOR.claimKinds, `${card.id}.claimKind`).toContain(card.claimKind);
    }
  });

  it('要件 id 唯一，且每张卡都有 satisfiedBy 与 typicalEvidence（变异：删掉某张卡的 typicalEvidence → 红）', () => {
    const ids = (LABOR.elementCards ?? []).map((c) => c.id);
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
    for (const card of LABOR.elementCards ?? []) {
      expect(card.satisfiedBy.length, `${card.id}.satisfiedBy`).toBeGreaterThan(0);
      expect(card.typicalEvidence.length, `${card.id}.typicalEvidence`).toBeGreaterThan(0);
      for (const e of card.typicalEvidence) expect(e.trim(), `${card.id} 的空补证项`).not.toBe('');
    }
  });

  it('burdenLabels 覆盖全部五个编码（少一个的形态是要件表里那一列印出 undefined）', () => {
    for (const b of BURDENS) expect(LABOR.burdenLabels?.[b as Burden], b).toBeTruthy();
  });
});

describe('要件卡：每条 basis 都解析到登记簿里逐字核过的原文', () => {
  const anchors = (LABOR.elementCards ?? []).flatMap((c) =>
    c.basis.map((b) => ({ element: c.id, anchor: b.anchor, key: keyOf(b.anchor), verified: b.verified })),
  );

  it('🔒 地板：确实扫到了一批锚点', () => {
    expect(anchors.length).toBeGreaterThanOrEqual(30);
  });

  it('① 每个锚点都在知识库里找得到（变异：把某条 basis 的条号改成库里没有的 → 红）', () => {
    const missing = anchors.filter((a) => !BY_ANCHOR.has(a.key));
    expect(
      missing.map((a) => `${a.element} → ${a.anchor}`),
      '这些要件的依据在 knowledge/index.json 里没有对应的 statute_quotes。' +
        '缺什么：一条逐字原文。为什么缺：法条卡还没建，或条号/法名写得与卡里不一致（两侧都走 articleKey 归一）。' +
        '怎么办：去 knowledge/packs/statutes/ 建卡或补条，跑 gen-knowledge-index.py --strict 与 verify-quotes.py。',
    ).toEqual([]);
  });

  it('② 支撑它的卡可信度都是「原文核实」（变异：把某张法条卡改成二手转述 → 红）', () => {
    const bad: string[] = [];
    for (const a of anchors) {
      const cards = BY_ANCHOR.get(a.key) ?? [];
      if (!cards.some((c) => c.confidence === '原文核实')) {
        bad.push(`${a.element} → ${a.anchor}（${cards.map((c) => `${c.id}:${c.confidence}`).join('、')}）`);
      }
    }
    expect(bad, '这些依据只挂在非「原文核实」的卡上（裁决⑤：可用索引里不允许有二手/待核实的卡）').toEqual([]);
  });

  it('③ 每条引文与官方原件逐字一致（跑 verify-quotes.py；变异：改卡里某条 text 一个字 → 红）', () => {
    const bad: string[] = [];
    for (const a of anchors) {
      const states = VERIFY_STATE.get(a.key);
      if (!states) {
        bad.push(`${a.element} → ${a.anchor}：verify-quotes 里没有这一条（等于没核过）`);
        continue;
      }
      if (!states.has('一致')) bad.push(`${a.element} → ${a.anchor}：${[...states].join('、')}`);
    }
    expect(bad, '这些依据没有一条通过逐字核验——按裁决③，它们不能被当作依据用').toEqual([]);
  });

  it('④ 全部锚点都标 verified（标 false 的要件按 elements.ts 会被压成 unverified，不许进「成立」）', () => {
    // 【这条不是重复】上面三条查的是"库里核过没有"，这条查的是"卡片自己有没有如实标"。
    // 两者分叉的形态是：库里核过了、卡片却标着 false（要件白白降级），
    // 或者反过来——卡片标 true 而库里根本没有那条原文，那正是①②③要拦的事。
    const unverified = anchors.filter((a) => !a.verified);
    expect(
      unverified.map((a) => `${a.element} → ${a.anchor}`),
      '这几条 basis 自报未核实。核过了就把 verified 改回 true；确实核不到的，' +
        '这个要件会被压成 unverified 且不许进「成立」——那是刻意的，不要靠改 true 绕过去。',
    ).toEqual([]);
  });
});

describe('要件卡：举证责任两条规则不许互相顶替', () => {
  const cards = LABOR.elementCards ?? [];

  it('burden 分布落在预期上（改任一张卡的 burden → 这里的计数当场变）', () => {
    const tally = new Map<Burden, number>();
    for (const c of cards) tally.set(c.burden, (tally.get(c.burden) ?? 0) + 1);
    // 【为什么钉计数而不是"都合法"】"都合法"是恒真的（类型已经限死取值）。
    // 计数变了就意味着有人挪动了某一项的举证责任——那是本产品最贵的一类改动，
    // 必须经过一次停顿（改判据 = 记账），而不是安静地跟着代码走。
    expect(Object.fromEntries([...tally].sort())).toEqual({
      claimant: 10,
      reversed_interpretation: 2,
      reversed_procedure_rules: 5,
    });
  });

  it('标 reversed_interpretation 的，basis 里必须有司法解释（一）第四十四条（限定事项那一条）', () => {
    const bad = cards
      .filter((c) => c.burden === 'reversed_interpretation')
      .filter((c) => !c.basis.some((b) => keyOf(b.anchor) === INTERPRETATION_ANCHOR))
      .map((c) => c.id);
    expect(
      bad,
      '「用人单位负举证责任」这句话只写在司法解释（一）第四十四条里，且只管它列举的那几类决定。' +
        '拿别的条去撑这一档，等于把一条更弱的规则说成了更强的那一条——' +
        '用户据此认为"这件事我不用证"，而开庭那天没人替他证。',
    ).toEqual([]);
  });

  it('标 reversed_procedure_rules 的，basis 里必须有证据偏在那两条之一', () => {
    const bad = cards
      .filter((c) => c.burden === 'reversed_procedure_rules')
      .filter((c) => !c.basis.some((b) => PROCEDURE_ANCHORS.includes(keyOf(b.anchor))))
      .map((c) => c.id);
    expect(
      bad,
      '证据偏在的规则是「东西在对方手里的，对方应当提供；不提供的承担不利后果」——' +
        '它不是把举证责任整条搬过去。撑它的只能是调解仲裁法第六条或仲裁办案规则第十三条。',
    ).toEqual([]);
  });

  it('没有要件既标限定倒置又只挂偏在条（两条规则强度不同，混用会讲反）', () => {
    const bad = cards
      .filter((c) => c.burden === 'reversed_interpretation')
      .filter((c) => c.basis.every((b) => PROCEDURE_ANCHORS.includes(keyOf(b.anchor))))
      .map((c) => c.id);
    expect(bad).toEqual([]);
  });
});
