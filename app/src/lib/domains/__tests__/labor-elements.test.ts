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
import {
  BURDENS,
  buildElementSheet,
  representativeElementIds,
  type Burden,
  type ElementFactsView,
} from '@/lib/cases/elements';
import { buildIssueTable, counterpartyDecisionOnFile } from '@/lib/cases/issue-table';

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

/** 时间线一行。`title` / `detail` 只有挂了取值判定的槽才读得到（见 lib/cases/elements.ts）。 */
type TimelineRow = ElementFactsView['timeline'][number];

/**
 * 档案覆盖项。时间线那两格**可省**：本文件里大半用例问的是"这个类别下有没有记录"，
 * 逐条把 title / detail 写出来只会把它们真正在说的那件事淹掉；
 * 而问"那段字说的是不是这件事"的用例（N-2b）自己会把 title 写上。
 */
type FactsOver = Partial<Omit<ElementFactsView, 'timeline'>> & {
  timeline?: readonly (Pick<TimelineRow, 'kind' | 'source_tier'> & Partial<TimelineRow>)[];
};

const timelineOf = (over: FactsOver): readonly TimelineRow[] =>
  (over.timeline ?? []).map((e) => ({ title: '', detail: null, event_type: null, ...e }));

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

/** 「公司确实作出过那个决定」那条时间线槽，与它判不过时缺口那一行的名字。 */
const COMPANY_ACTION_SLOT = 'timeline:公司动作';
const COMPANY_ACTION_MISSING =
  '公司的解除/终止决定（请把公司作出这个决定的那一刻记成一条时间线事件，' +
  '并把类型选成「公司作出的解除/终止决定」——选了就不用靠那段字去猜）';
/**
 * N-2a 那一行的名字（2026-09-11 台账「协商一致解除」票）。上面那行**再加协商一致解除那一档**。
 *
 * 【为什么这两行必须是两个常量】N-2a 认的事件类型比另外三处多一种（协商解除），
 * 缺口那一行是用户读到的唯一出路——两处共用一行字的形态是：一个已经协商一致签完字的人
 * 读到「请把类型选成『公司作出的解除/终止决定』」，而他手上那份协议对应的是另一格。
 */
const N2A_ACTION_MISSING =
  '公司的解除/终止决定（请把公司作出这个决定的那一刻记成一条时间线事件：' +
  '单方解除、辞退、合同到期终止的，类型选「公司作出的解除/终止决定」；' +
  '协商一致解除的，把那份**已签**协议按「公司文件」登记为证据，' +
  '事件类型选「协商解除提议或协议」——只是递过来、还没签的那一份是提议，不算）';
/** 某张卡判不过时缺口清单里那一行。N-2a 一份，其余三处一份（见上面两个常量）。 */
const actionMissingFor = (id: string): string => (id === 'N-2a' ? N2A_ACTION_MISSING : COMPANY_ACTION_MISSING);
/** 一条**过得了判定**的「公司动作」：判的是那段字，所以夹具必须把它写出来。 */
const DECISION_EVENT = '公司送达《解除劳动合同通知书》';

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
    //
    // ── 记账：10/2/5 → 11/2/5（复审 2026-09-10 第一条，N-2 拆成两张卡）──
    // 原 N-2「解除或终止落在第四十六条列举的情形里」整条标 reversed_interpretation，
    // 而第四十六条第一项是「劳动者依照本法第三十八条规定解除劳动合同」——那份解除是
    // **劳动者自己发出的**，不是司法解释（一）第四十四条说的「用人单位作出的……决定」，
    // 那条原文管不到它。拆成 N-2a（用人单位决定型，仍倒置）与 N-2b（§38 被迫解除型，
    // 谁主张谁举证）之后，多出来的那一条落在 claimant 上。
    expect(Object.fromEntries([...tally].sort())).toEqual({
      claimant: 11,
      reversed_interpretation: 2,
      reversed_procedure_rules: 5,
    });
  });

  it('§38 被迫解除那条路**不许**标成对方举证（复审 2026-09-10 第一条；改回 reversed_* 即红）', () => {
    // 【为什么单钉这一条，而不是只靠上面的计数】计数只说"有 11 条 claimant"，
    // 不说是哪 11 条：把 N-2b 改回倒置、同时把另一张卡改成 claimant，计数照样对得上。
    const forced = cards.find((c) => c.id === 'N-2b');
    expect(forced, '要件卡里没有 N-2b（§38 被迫解除那条路）').toBeTruthy();
    expect(forced!.burden).toBe('claimant');
    // 它的锚点里**不许**出现司法解释（一）第四十四条：那条是限定事项倒置的唯一出处，
    // 挂上去就等于说"这件事公司来证"。
    expect(forced!.basis.map((b) => keyOf(b.anchor))).not.toContain(INTERPRETATION_ANCHOR);
    // 而第三十八条与第四十六条必须在（这条路的实体依据）
    for (const article of ['第三十八条', '第四十六条']) {
      expect(
        forced!.basis.map((b) => keyOf(b.anchor)),
        `N-2b 少了劳动合同法${article}`,
      ).toContain(articleKey('中华人民共和国劳动合同法', article));
    }
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

describe('双倍工资-2：字段有值 ≠ 事实成立（复审 2026-09-10 第二条）', () => {
  // 【它守什么】首诊「合同签订次数」是自由文本，resolveSlot 对 basics 只判填没填。
  // 于是用户报「2 次」也算这个要件有自述支撑——要件表写着「仍没有订立书面劳动合同：成立·待证」，
  // 而他刚刚亲口说签过两次。判据钉的是**取值**这一格，不是"填了没填"。
  const factsWith = (contractCount: string | null): ElementFactsView => ({
    case: { employed_from: '2024-01-01', position: null, monthly_wage_fen: null, contract_count: contractCount },
    claims: [{ kind: '双倍工资', source_tier: '自述' }],
    timeline: [],
    companies: [],
    evidence: [],
  });
  const rowOf = (contractCount: string | null) =>
    buildElementSheet(factsWith(contractCount), LABOR.elementCards ?? [], ['双倍工资']).rows.find(
      (r) => r.id === '双倍工资-2',
    )!;

  it('🔒 地板：这张卡还在，且它认的就是那一格', () => {
    const card = (LABOR.elementCards ?? []).find((c) => c.id === '双倍工资-2');
    expect(card, '双倍工资-2 不见了').toBeTruthy();
    expect(card!.satisfiedBy).toEqual(['basics:contract_count']);
    expect(card!.slotChecks?.['basics:contract_count'], '这一格没有取值判定').toBeTruthy();
  });

  it('「没签 / 无 / 0 / 一份都没有」这一类 ⇒ 成立·待证', () => {
    for (const raw of ['没签', '一次都没签', '一份都没有', '无', '0', '0 次', '零次', '从来没有签过书面合同']) {
      const row = rowOf(raw);
      expect(row.status, `「${raw}」被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('「2 次」这一类表示签过 ⇒ **不许**成立·待证，而是缺失并点名「无合同期间」（变异：改回只判填没填 → 红）', () => {
    for (const raw of ['2 次', '两次', '续签过一次', '签了1次', '2']) {
      const row = rowOf(raw);
      expect(row.status, `「${raw}」被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual(['无合同期间']);
    }
  });

  it('**签过**的说法不许被判成"没签"（第二轮复审 2026-09-10；把 ④ 改回 /[没未无]/ → 红）', () => {
    // 【这一组是上一版真的判错的那几个】旧实现最后一步是"剩下的看有没有否定词 /[没未无]/"，
    // 于是下面每一个都被判成「没签」⇒ 二倍工资-2 印「成立·待证」。
    // 「签了无固定期限合同」是北京老员工最常见的答案：合同签了，期限是无固定期限，
    // 而要件表告诉他"仍没有订立书面合同，这一项成立·待证"——他据此去主张一笔提不了的钱。
    for (const raw of [
      '无固定期限',
      '签了无固定期限合同',
      '未续签',
      '没续签',
      '签过，后来没续签',
      '签了但没盖章',
      '一直没续签',
      '签了合同但公司没给我',
    ]) {
      const row = rowOf(raw);
      expect(row.status, `「${raw}」（这是签过的说法）被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual(['无合同期间']);
    }
  });

  it('认不准的答案一律偏向「缺失」（误差方向：多问一句 ≪ 让人去主张一笔提不了的钱）', () => {
    for (const raw of ['不记得了', '待确认', 'HR 说回头补']) {
      expect(rowOf(raw).status, raw).toBe('缺失');
    }
    // 这一格还空着时也是缺失，且点的是同一个名字（不是 basics:contract_count）
    expect(rowOf(null).missingSlots).toEqual(['无合同期间']);
  });
});

describe('锚点不只要「在库里、核过了」，还要真的支撑那个要件（复审 2026-09-10 第五条）', () => {
  // 【为什么单钉这一条】上面 ①②③ 查的是"这条原文在不在、可信度够不够、逐字对不对得上"——
  // **选条松照样全绿**：欠薪-4「欠付的期间与金额已经算清」此前挂的是工资支付暂行规定第九条与
  // 北京市工资支付规定第十二条，两条原文都在库里、都核过、都一致，而它们讲的是
  // 「劳动关系双方依法解除或终止劳动合同时，用人单位应在解除或终止劳动合同时一次付清」——
  // 那是**离职结算**，与"哪个月该发多少、实发多少、差多少"没有支撑关系。
  // 在职欠薪（还没解除）的案子里它们根本不适用，而争点行照样印着「依据 工资支付暂行规定|第九条」。
  it('欠薪-4 不挂「解除/终止时一次付清」那两条，挂的是及时足额支付与约定的发薪日（变异：换回 §9 / 北京§12 → 红）', () => {
    const card = (LABOR.elementCards ?? []).find((c) => c.id === '欠薪-4');
    expect(card, '欠薪-4 不见了').toBeTruthy();
    const keys = card!.basis.map((b) => keyOf(b.anchor));
    for (const [law, article] of [
      ['工资支付暂行规定', '第九条'],
      ['北京市工资支付规定', '第十二条'],
    ] as const) {
      expect(keys, `欠薪-4 又挂上了「一次付清」那一条（${law}${article}）`).not.toContain(
        articleKey(law, article),
      );
    }
    expect(keys, '少了及时足额支付那一条').toContain(articleKey('中华人民共和国劳动合同法', '第三十条'));
    expect(keys, '少了约定发薪日那一条').toContain(articleKey('工资支付暂行规定', '第七条'));
  });
});


describe('N 的两条解除路径：互斥、二选一（第二轮复审 2026-09-10 第三、四条）', () => {
  // 【它守什么】N-2 拆成两张卡之后有两个新的错法，都是"回包 200、每行读起来都正常"：
  //   ① N-2b 只认「沟通记录」——那是最常见的一类材料（微信截图），于是从没发过
  //      被迫解除通知的人，要件表上「路径二」写着「成立」；
  //   ② 两条路径二选一，而要件表按诉求列全 ⇒ 另一条恒是「缺失」，风险区间见「缺失」就落
  //      「依据不足」、争点表还多一条让他去补那份根本不存在的通知书。
  const factsWith = (over: FactsOver = {}): ElementFactsView => ({
    case: {
      employed_from: '2020-03-01',
      position: '后端工程师',
      monthly_wage_fen: 2_500_000,
      contract_count: '续签过一次',
    },
    claims: [{ kind: 'N', source_tier: '自述' }],
    companies: [{ role: '签约主体', source_tier: '自述' }],
    evidence: [],
    ...over,
    timeline: timelineOf(over),
  });
  const sheetOf = (over: FactsOver = {}) =>
    buildElementSheet(factsWith(over), LABOR.elementCards ?? [], ['N']);
  const rowOf = (id: string, over: FactsOver = {}) =>
    sheetOf(over).rows.find((r) => r.id === id)!;

  it('🔒 地板：两张卡都在，且挂在同一个「任选其一」分组下', () => {
    const a = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2a')!;
    const b = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2b')!;
    expect(a, 'N-2a 不见了').toBeTruthy();
    expect(b, 'N-2b 不见了').toBeTruthy();
    expect(a.alternativeGroup, 'N-2a 没有分组').toBeTruthy();
    expect(b.alternativeGroup, '两条路径不在同一组里').toBe(a.alternativeGroup);
  });

  it('一份「沟通记录」**不能**把被迫解除那条路抬成「成立」（变异：satisfiedBy 改回只认沟通记录 → 红）', () => {
    // 微信截图是档案里最常见的一类材料。只认它的形态是：走公司解除那条路的用户
    // 上传几张与 HR 的聊天记录，「路径二：你依照第三十八条提出被迫解除」就写着「成立」，
    // 而他从来没发过任何解除通知——两条互斥的路径同时"成立"，要件表自相矛盾。
    const row = rowOf('N-2b', { evidence: [{ category: '沟通记录' }] });
    expect(row.status, `只有一份沟通记录时 N-2b 被判成了 ${row.status}`).toBe('缺失');
    expect(row.missingSlots, '缺口没点到那份通知').toContain(N2B_MISSING);
  });

  // ── 那条「我方动作」还要过取值判定（S6 backlog ①，2026-09-10）──
  // 【它守什么】「我方动作」是四种 kind 里最杂的一格：异议函、加班申请、整理证据目录
  // 都落在它下面。只判"这个类别下有没有记录"的形态是——一条异议函 + 一张聊天截图，
  // 就把「路径二：你依照第三十八条提出被迫解除」抬到「成立·待证」，而这个人从来没发过
  // 任何解除通知；同组那条公司解除路径（他真正该走的那条）反而被它盖住。
  const N2B_SLOT = 'timeline:我方动作';
  /** 缺口那一行对外的名字。**带着出路**：缺的不是"一份文件"，是把发出通知这件事记成一条事件。 */
  const N2B_MISSING =
    '被迫解除通知（请把发出通知这件事记成一条时间线事件，' +
    '并把类型选成「我发出的被迫解除通知」——选了就不用靠那段字去猜）';
  /** 一条「我方动作」+ 一份沟通记录（另一个槽满足），只让那段字说话。 */
  const withMyAction = (title: string, tier = '自述') =>
    rowOf('N-2b', {
      evidence: [{ category: '沟通记录' }],
      timeline: [{ kind: '我方动作', source_tier: tier, title }],
    });

  it('🔒 地板：N-2b 的那个时间线槽真的挂着取值判定（删掉 slotChecks → 红）', () => {
    const card = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2b')!;
    expect(card.satisfiedBy, 'N-2b 认的槽变了').toEqual(['evidence:沟通记录', N2B_SLOT]);
    expect(card.slotChecks?.[N2B_SLOT], '那条「我方动作」没有取值判定').toBeTruthy();
    expect(card.slotChecks?.[N2B_SLOT]?.missingAs).toBe(N2B_MISSING);
    // 【为什么连这半句也钉】（S6 backlog ② 复审裁定）首诊那段整段自述也是一条「我方动作」，
    // 判定不认它。只写「被迫解除通知」的形态是：在首诊里写过"我已经发了被迫解除通知"的人
    // 读到这一行，会以为系统没收到他的话——他缺的是把这件事记成一条时间线事件。
    expect(card.slotChecks?.[N2B_SLOT]?.missingAs, '缺口只报了名字，没给出路').toContain('时间线事件');
  });

  it('(a) 异议函那条「我方动作」+ 沟通记录 ⇒ 仍是「缺失」，且缺口点名「被迫解除通知」（变异：去掉判定 → 红）', () => {
    // 【这就是 backlog ① 要根治的那一格】异议函是约谈期最常做的动作之一，
    // 它与"发出被迫解除通知"隔着整条路径。判成「成立·待证」的后果是三层，每一层都读得通：
    // 路径二成了本组代表行 ⇒ 用户不去准备那份通知、也不去固定欠薪的初步证明 ⇒
    // 开庭那天仲裁庭要他先举出个头，而他手上什么都没有。
    const row = withMyAction('向公司发出调岗异议函');
    expect(row.status, `异议函把 N-2b 抬成了 ${row.status}`).toBe('缺失');
    expect(row.missingSlots, '缺口没点名那份被迫解除通知').toEqual([N2B_MISSING]);
    // 它是〔未记录〕不是〔不成立〕：这条我方动作记的只是另一件事
    expect(row.status).not.toBe('不成立');
  });

  it('(b) 被迫解除通知那条事件（自述档）+ 沟通记录 ⇒ 成立·待证（不是「成立」：回执进档前那句话只有你自己说）', () => {
    const row = withMyAction('发出《被迫解除劳动合同通知书》，事由：拖欠工资两个月');
    expect(row.status).toBe('成立·待证');
    expect(row.missingSlots).toEqual([]);
    expect(row.selfReportedSlots, '这一条的支撑只有当事人自己说').toContain(N2B_SLOT);
  });

  it('(c) 那条事件由文件提取写入（书证档）⇒ 成立（自证上面不是恒「待证」）', () => {
    // 书证档 = DOC_EXTRACT_ORIGIN 那条路：通知书与 EMS 回执进了证据库、由提取写回时间线。
    const row = withMyAction('发出《被迫解除劳动合同通知书》，事由：拖欠工资两个月', '书证');
    expect(row.status).toBe('成立');
  });

  it('🔴 档位只从**过了判定的那条**里取：异议函带着书证也抬不动它（变异：从全部同类事件里取最强档 → 红）', () => {
    // 【这条最贵】用户把异议函的邮件回执传了上来（书证档），另有一条自述的被迫解除通知。
    // 从全部同类事件里取最强档的形态是：这个槽显示成书证档 ⇒ N-2b 写着「成立」，
    // 而那份书证证的是异议函，不是那份解除通知。
    const row = rowOf('N-2b', {
      evidence: [{ category: '沟通记录' }],
      timeline: [
        { kind: '我方动作', source_tier: '书证', title: '向公司发出调岗异议函' },
        { kind: '我方动作', source_tier: '自述', title: '发出被迫解除劳动合同通知书' },
      ],
    });
    expect(row.status, '异议函那份书证把 N-2b 抬到了「成立」').toBe('成立·待证');
  });

  it('(d) 词表：认的那 8 种说法（变异：删掉判定里任一条正向规则 → 红）', () => {
    for (const raw of [
      '发出被迫解除劳动合同通知书',
      '向公司邮寄《被迫解除劳动合同通知书》',
      '以未足额支付劳动报酬为由通知解除劳动合同',
      '依据劳动合同法第三十八条提出解除劳动合同',
      '以公司未缴纳社会保险为由解除劳动合同',
      'EMS 寄出解除通知，理由写的是拖欠工资三个月',
      '因欠薪提出被迫离职',
      '按 38 条发了解除通知',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（这是发过通知的说法）被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('(d) 词表：不认的那 14 种说法，一律落「缺失」并点名（变异：把判定放宽到只认「解除」两个字 → 红）', () => {
    // 【为什么反样本比正样本多】认不准时一律判"不算"：漏判只是让用户多读一行"该补什么"，
    // 误判会让一个从没发过通知的人以为这条路已经走通。两个方向的代价不对等。
    // 下面每一条都是"放宽一点就会被误认"的那种：带「解除」两个字的有五条。
    for (const raw of [
      '提交辞职信',
      '递交辞职报告，写的个人原因',
      '口头提出主动离职',
      '与公司协商解除劳动合同并签了离职协议',
      '向公司发出调岗异议函',
      '向公司提交加班费申请',
      '整理证据目录',
      '收到公司的《解除劳动合同通知书》后回复确认',
      '拒绝签署解除协议',
      '咨询律师被迫解除的可行性',
      '向公司发函要求补缴社保',
      '催问工资什么时候发',
      '因公司拖欠工资，双方协商解除劳动合同',
      '打算下周发被迫解除通知',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（这不是那份通知）被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual([N2B_MISSING]);
    }
  });

  // ── 方向：同一批词，两个相反的意思（S6 backlog ① 复审，2026-09-10）──
  // 【它守什么】上一版的规则「事由 + 解除动作同现即认」不看**谁做的**，于是"公司把我解除了、
  // 顺口提一句他们还欠着工资"这一整类叙事被判成"我发出了被迫解除通知"。它同时错两头：
  // 路径二被抬起来（用户不去准备那份通知、不去固定欠薪的初步证明），
  // 而他真正该走的路径一被同组的代表行盖住——两个错都读起来很顺。
  it('🔴 公司作出的解除 + 提到欠薪，一条都不认（变异：去掉方向条件 → 红；去掉前置排除 → 红）', () => {
    for (const raw of [
      // 复审点名的那两条
      '公司以我旷工为由解除劳动合同，其实是他们拖欠工资',
      'HR 通知我解除劳动合同，理由是拖欠工资期间旷工',
      // 同一类的其余叙事
      '公司今天正式解除劳动合同，拖欠的两个月工资还没结',
      '单位把我辞退了，还克扣了上个月工资',
      '老板当场开除我，说拖欠的提成一分不给',
      '人事通知我终止劳动合同，欠薪的事只字不提',
      '公司发来解除劳动合同通知书，理由写的是绩效，实际上一直拖欠工资',
      '公司单方解除劳动关系，还拖欠着三个月工资',
      '公司以拖欠工资期间旷工为由解除劳动合同',
      '上周五被叫去开会，当场解除劳动合同，说是优化，实际一直拖欠工资',
      '我提出过欠薪的事，公司这周解除劳动合同',
      '劳动仲裁前，公司才通知我解除劳动合同，欠薪也没结清',
      '公司说我不能胜任工作，解除劳动合同，可实际是拖欠工资引起的',
      'HR 约谈时说公司决定解除劳动合同，我提到拖欠工资也没用',
      // 这两条只有**前置排除**拦得住：规则⑤（「被迫」两个字）与规则⑦（条号）本身不问方向
      '公司通知我解除劳动合同，我觉得这就是被迫解除',
      'HR 说公司依据第三十八条解除劳动合同，因为我旷工',
      // ── 主语与动词之间隔着字的那几种（二次复审点名，2026-09-10）──
      // 判"谁做的"若只排掉紧挨动词的那几个公司词，这六条全部漏成"我发出了通知"：
      // 前四条的「发/发出/发送」前面紧挨的是「我」（与格，不是主语），后两条隔着一个职务名。
      '公司向我发出解除劳动合同通知书，欠薪没结',
      '公司给我发了解除劳动合同通知书，拖欠的工资也没给',
      'HR 给我发送了解除通知，理由写的是旷工，实际是拖欠工资',
      '公司对我发出解除通知，还欠着两个月工资',
      '人事经理提出解除劳动合同，拖欠工资一分没给',
      '单位领导递交解除劳动合同通知书给我，欠薪未结',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（是公司解除的）被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual([N2B_MISSING]);
      // 它是〔未记录〕不是〔不成立〕：公司解除了不等于"你没发过通知"这件事被证伪
      expect(row.status).not.toBe('不成立');
    }
  });

  it('🔴 收件与格：「向/给/对 + 公司一侧」后面那个动作是我做的（变异：白名单退回只放「向公司」→ 红；两条方向判定去掉与格例外 → 各自红）', () => {
    // 【它守什么】(三次复审点名，2026-09-10) 上一条那 22 例把"公司词 + 发出动词"一律判成公司发的，
    // 而同一批公司词还能当**收件人**：「我给 HR 发了被迫解除通知书」「向用人单位邮寄…」——
    // 发出的是我，HR / 用人单位是收件方。判成「缺失」的形态是：这个人手上正拿着那份通知书的
    // 回执，要件表却让他去补一份他已经发过的通知，而路径二本该是他的代表行。
    // 分界是公司词前面的那个介词：「公司给我发了…」是公司发的，「我给公司发了…」是我发的。
    for (const raw of [
      '公司欠薪，我给HR发了被迫解除通知书',
      '向单位发出被迫解除劳动合同通知书',
      '我给老板发了被迫解除劳动合同通知书，因为拖欠工资',
      '已向人事提交被迫解除劳动合同通知书',
      // 「用人单位」是那份通知书上的法定称谓，与格与公司词之间还隔着「用人」两个字
      '已向用人单位邮寄被迫解除劳动合同通知书并留存回执',
      // 这一条没写「被迫」两个字，走的是⑧：事由 + 解除动作 + 那个动作是我发出的
      '因拖欠工资，向HR发送解除劳动合同通知',
      // 收件方与发出动词之间还隔着字（「正式」）：白名单靠那一小段的放行认它
      '拖欠工资三个月，已向公司正式发出解除劳动合同通知书',
      // 收件方带着定语（「公司的 HR」）：隔着的那一小段里就是那个公司词自己
      '向公司的HR发出被迫解除劳动合同通知书',
      // 连发出动词都没有，只有条号 + 解除：这一条要「公司作出的解除」那条也认得出与格宾语
      '依据劳动合同法第三十八条向公司解除劳动合同',
      // 「以…为由」那条形态也一样：与格宾语不是主语，这是我据欠薪解除，不是公司给的理由
      '向公司以拖欠工资为由解除劳动合同',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（这是我发给公司的）被判成了 ${row.status}`).toBe('成立·待证');
    }
    // 反臂：光有那个介词短语、后面没有发出动词时说的是另一件事——解除是公司作出的，方向相反。
    //（白名单若不要那个发出动词，这一条当场被判成"我发出了被迫解除通知"。）
    const objection = withMyAction('我对公司解除劳动合同有异议，他们还拖欠工资');
    expect(objection.status, '「对公司…有异议」被判成了我发出通知').toBe('缺失');
    expect(objection.missingSlots, '这一条的缺口没点名').toEqual([N2B_MISSING]);
  });

  it('两件事真的都发生时不误伤：公司放话要裁，我先发出了被迫解除通知书', () => {
    // 【为什么要有这条】前置排除若写成"提到公司解除就一律不认"，这个人——本行当里
    // 「先下手」那一类——会读到「还差那份通知」，而他手上正拿着 EMS 回执。
    expect(withMyAction('公司放话要裁我，我当天就发出了被迫解除通知书').status).toBe('成立·待证');
  });

  it('反臂：同一小句里出现「公司」，但主语是我 ⇒ 照认（变异：主语短语放行裸「我／本人」→ 红；放宽成"沾到公司就不认" → 红）', () => {
    // 【它守什么】上一条那六种漏网的修法是"公司主语与动词之间还能隔着几个字"。
    // 这一层若放宽成"这一小句里出现过公司词就不算我发的"，下面这些——本行当里最常见的
    // 一句话叙事（不打逗号、事由与动作写在一起）——会当场反向误杀。
    // 分界在一个介词：「公司**给我**发了…」是公司发的，「公司拖欠工资**我**发出…」是我发的。
    for (const raw of [
      // 这两条卡在分界上：公司词与动词之间只隔着三四个字，隔着的那个字里有「我 / 本人」
      //（放行裸「我」→ 这两条当场被判成公司发的 ⇒ 缺失）
      '公司欠薪我发出被迫解除通知书',
      '公司欠薪本人发出被迫解除通知书',
      '公司拖欠工资我发出被迫解除通知书',
      '我以公司拖欠工资为由向公司提出解除劳动合同',
      '已通知公司解除劳动关系，因其未足额支付工资',
      '本人发函给公司，以拖欠工资为由解除劳动合同',
      '公司拖欠工资，我提出解除劳动合同',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（这是我发的）被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('🔴「被迫离职 / 被迫辞职」没有第三十八条的事由或条号就不认（变异：去掉这层收紧 → 红）', () => {
    // 【它守什么】这两句在庭外还兼指"被逼着自己走"：HR 逼签字、公司逼迫辞职。
    // 那是胁迫辞职，走的不是第三十八条那条路——认它的形态是，一个被逼着签了字的人
    // 读到路径二「成立·待证」，于是既不去追那份通知，也不去主张胁迫。
    for (const raw of ['HR 逼我签字，我被迫离职了', '被公司逼迫辞职，被迫离职']) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（这是被逼着自己走）被判成了 ${row.status}`).toBe('缺失');
    }
    // 反臂：带上事由就是第三十八条那件事（正样本表里那条「因欠薪提出被迫离职」的兄弟）
    expect(withMyAction('因公司未缴纳社会保险，我被迫辞职').status).toBe('成立·待证');
  });

  it('detail 那段字也算数：标题只写「发函」，事由写在详情里', () => {
    // ev() 把事由记在 detail 是时间线最常见的形态；只读 title 的形态是这一条恒判不过。
    const row = rowOf('N-2b', {
      evidence: [{ category: '沟通记录' }],
      timeline: [
        { kind: '我方动作', source_tier: '自述', title: '向公司发函', detail: '以拖欠工资为由解除劳动合同' },
      ],
    });
    expect(row.status).toBe('成立·待证');
  });

  /**
   * **路径一真的走通**的那份档案：公司那份书面决定在档，且时间线上记着公司作出了这个决定。
   * 【为什么不是只放一份「公司文件」】那个类别很宽（员工手册、规章制度、工资结构表都在里面），
   * 只放一份文件的形态见下面「只有一份公司文件」那一条——它此刻恒是「缺失」。
   */
  const PATH_ONE: FactsOver = {
    evidence: [{ category: '公司文件' }],
    // 【为什么这条事件必须把标题写出来】（2026-09-10「公司动作」票）这个槽挂了取值判定：
    // 记的是不是公司**已经作出**的那个解除决定，看的就是这段字。空标题一律判不过。
    timeline: [{ kind: '公司动作', source_tier: '书证', title: DECISION_EVENT }],
  };

  it('路径一走通时，路径二的「缺失」不进争点表（变异：规则一不按分组取代表行 → 红）', () => {
    const sheet = sheetOf(PATH_ONE);
    expect(rowOf('N-2a', PATH_ONE).status, '这个案子走的是路径一').toBe('成立');
    expect(rowOf('N-2b', PATH_ONE).status).toBe('缺失');
    // 要件表**照旧两条都画**（用户要知道另一条路长什么样），进争点表的只有代表行
    expect(sheet.rows.map((r) => r.id), '要件表不该把另一条路径藏起来').toContain('N-2b');
    const issues = buildIssueTable(sheet.rows, {}, true);
    expect(
      issues.rows.map((r) => r.id),
      '路径二的「缺失」进了争点表：用户会去准备一份他从没发过、也不需要发的被迫解除通知',
    ).not.toContain('N-2b');
  });

  // ── 路径一不得靠任意一份「公司文件」成立（第三轮小修 2026-09-10）──
  it('只有一份「公司文件」**不能**把公司决定那条路抬成「成立」（变异：去掉 timeline:公司动作 这个槽 → 红）', () => {
    // 【它守什么】「公司文件」是个很宽的类别：员工手册、规章制度、工资结构表都落在里面。
    // 只认它的形态是——风闻裁员、还没收到任何解除通知、先把员工手册传上来的那个人，
    // 「路径一：公司作出的决定」当场写着「成立」，于是它成了本组的代表行，
    // 而同组那条被迫解除路径（他真正该走的那条）从争点表与风险缺口里一起消失。
    const only = { evidence: [{ category: '公司文件' }] };
    const a = rowOf('N-2a', only);
    expect(a.status, `只有一份公司文件时 N-2a 被判成了 ${a.status}`).toBe('缺失');
    expect(a.missingSlots, '缺口没点到"公司确实作出过这个决定"那条记录').toContain(N2A_ACTION_MISSING);
    // 同组那一条也还没走通 ⇒ 两条都是代表行，两条都留在争点表上
    expect(rowOf('N-2b', only).status).toBe('缺失');
    expect(
      buildIssueTable(sheetOf(only).rows, {}, true).rows.map((r) => r.id),
      '被迫解除那条路被一份员工手册挤出了争点表',
    ).toEqual(expect.arrayContaining(['N-2a', 'N-2b']));
  });

  it('公司文件 + 那条「公司动作」 ⇒ 路径一成立；事件只有自述时天花板是「成立·待证」', () => {
    // 【为什么两档都要钉】只钉「成立」那一格，把新槽写成恒 true 也是绿的；
    // 只钉「成立·待证」，两个槽取最强档（而不是最弱）同样绿。
    expect(rowOf('N-2a', PATH_ONE).status).toBe('成立');
    expect(
      rowOf('N-2a', {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '自述', title: DECISION_EVENT }],
      }).status,
      '事件只有当事人自己说，这一条就到不了「成立」',
    ).toBe('成立·待证');
  });

  it('只有那条「公司动作」、公司那份文件不在档 ⇒ 仍是「缺失」，且缺口点名那份文件', () => {
    // satisfiedBy 是「与」不是「或」：新加一个槽不许把原来那个槽变成可选。
    const row = rowOf('N-2a', {
      timeline: [{ kind: '公司动作', source_tier: '书证', title: DECISION_EVENT }],
    });
    expect(row.status).toBe('缺失');
    expect(row.missingSlots).toContain('evidence:公司文件');
  });

  it('两条路都还没走通时，两条都留在争点表上（这道分组不是"藏起一条"）', () => {
    const sheet = sheetOf();
    const ids = buildIssueTable(sheet.rows, {}, true).rows.map((r) => r.id);
    expect(ids, '什么材料都没有时，两条路径都该摆出来让用户自己认').toEqual(
      expect.arrayContaining(['N-2a', 'N-2b']),
    );
  });
});

// ══ 「公司动作」也过取值判定（2026-09-10 台账「公司动作」票，对称于 N-2b）══
describe('「公司动作」的取值判定：有这个类别的记录 ≠ 公司作出过解除决定', () => {
  // 【它守什么】「公司动作」记的是对方做的事，而对方在核心客户窗口（HR 约谈施压期、
  // 调岗降薪先来）做的**大多不是解除**：调岗通知、通知搬办公室、约谈、警告、年会通知。
  // 只判"这个类别下有没有记录"的形态是——一条调岗通知 + 一份员工手册（「公司文件」是
  // 最宽的那一类），N-2a / 2N-2 / 2N-3 三条一起写着「成立·待证」，争点表规则三照样触发，
  // 而这个人连解除通知都还没收到，照着做只能去固定一份不存在的纸。
  const factsWith = (over: FactsOver = {}): ElementFactsView => ({
    case: {
      employed_from: '2020-03-01',
      position: '后端工程师',
      monthly_wage_fen: 2_500_000,
      contract_count: '续签过一次',
    },
    claims: [
      { kind: 'N', source_tier: '自述' },
      { kind: '2N', source_tier: '自述' },
    ],
    companies: [{ role: '签约主体', source_tier: '自述' }],
    evidence: [],
    ...over,
    timeline: timelineOf(over),
  });
  const sheetOf = (over: FactsOver = {}) =>
    buildElementSheet(factsWith(over), LABOR.elementCards ?? [], ['N', '2N']);
  const rowOf = (id: string, over: FactsOver = {}) => sheetOf(over).rows.find((r) => r.id === id)!;
  /** 判同一件事的那三张卡：这一票要它们一起动，不许再有"三处对一处错"。 */
  const DECISION_CARDS = ['N-2a', '2N-2', '2N-3'] as const;
  /** 一份员工手册（「公司文件」类）+ 一条「公司动作」，只让那段字说话。 */
  const withCompanyAction = (title: string, tier = '自述'): FactsOver => ({
    evidence: [{ category: '公司文件' }],
    timeline: [{ kind: '公司动作', source_tier: tier, title }],
  });

  it('🔒 地板：三张卡的那个时间线槽真的挂着取值判定（删掉 slotChecks → 红）', () => {
    for (const id of DECISION_CARDS) {
      const card = (LABOR.elementCards ?? []).find((c) => c.id === id)!;
      expect(card.satisfiedBy, `${id} 认的槽变了`).toContain(COMPANY_ACTION_SLOT);
      expect(card.slotChecks?.[COMPANY_ACTION_SLOT], `${id} 的「公司动作」没有取值判定`).toBeTruthy();
      expect(card.slotChecks?.[COMPANY_ACTION_SLOT]?.missingAs).toBe(actionMissingFor(id));
      // 【为什么连这半句也钉】缺的不是"一份文件"，是把公司作出决定的那一刻记成一条事件。
      // 只报名字的形态是：用户又去证据库翻一遍，那一项一个字都不变（禁令配出路，§7.7）。
      expect(card.slotChecks?.[COMPANY_ACTION_SLOT]?.missingAs, '缺口只报了名字，没给出路').toContain(
        '时间线事件',
      );
    }
  });

  it('(a) 员工手册 + 一条调岗通知 ⇒ 三条全「缺失」、缺口点名、规则三不触发（变异：去掉判定 → 红）', () => {
    // 【这就是本票要根治的那一格】调岗降薪是施压期最常见的公司动作，它与"公司作出解除决定"
    // 隔着整条路径。判成「成立·待证」的后果是三层，每一层都读得通：三张卡一起抬起来 ⇒
    // N-2a 成了「N-解除路径」组的代表行、被迫解除那条路从争点表里消失 ⇒
    // 规则三让他去把「公司那份书面决定」原样固定下来，而档案里根本没有那份决定。
    const over = withCompanyAction('通知我调岗到保定分公司，下周报到');
    for (const id of DECISION_CARDS) {
      const row = rowOf(id, over);
      expect(row.status, `${id} 被一条调岗通知抬成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `${id} 的缺口没点名那条解除决定`).toEqual([actionMissingFor(id)]);
      // 它是〔未记录〕不是〔不成立〕：公司还没作出决定，不等于"公司没解除过"被证伪
      expect(row.status).not.toBe('不成立');
      expect(row.unresolvedSlots, `${id} 有认不出来的槽位（判定挂错地方了）`).toEqual([]);
    }
    // 规则三整条不触发，reasons 里只剩规则一
    const onFile = counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over));
    expect(onFile, '一条调岗通知就让"对方那份书面决定在档"成立了').toBe(false);
    const sheet = sheetOf(over);
    const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile }, sheet.rendered);
    for (const id of DECISION_CARDS) {
      const issue = table.rows.find((r) => r.id === id)!;
      expect(issue, `${id} 不在争点表上——「缺失」的要件恰恰最该摆出来`).toBeTruthy();
      expect(issue.reasons, `${id} 报了规则三，而档案里没有那份书面决定`).toEqual(['element_unsettled']);
    }
  });

  it('(b) 员工手册 + 解除通知那条事件（自述）⇒ 三条成立·待证，规则三仍不触发（书证档才算在档）', () => {
    const over = withCompanyAction('HR 通知我解除劳动合同，理由写的是绩效');
    for (const id of DECISION_CARDS) {
      expect(rowOf(id, over).status, `${id} 到不了「成立·待证」`).toBe('成立·待证');
    }
    expect(
      counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over)),
      '只有当事人自己说的口头通知不算"那张纸在档"',
    ).toBe(false);
  });

  it('(c) 那条事件由文件提取写入（书证档）⇒ 三条成立、规则三触发（自证上面不是恒不成立）', () => {
    const over = withCompanyAction(DECISION_EVENT, '书证');
    for (const id of DECISION_CARDS) {
      expect(rowOf(id, over).status, `${id} 到不了「成立」`).toBe('成立');
    }
    const onFile = counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over));
    expect(onFile, '那份书面决定已在档，规则三的第二个条件该成立了').toBe(true);
    const sheet = sheetOf(over);
    const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile }, sheet.rendered);
    // 举证责任整条在对方的那两张（N-2a / 2N-3）由规则三留在表上；2N-2 是我方举证，不该被它捞
    for (const id of ['N-2a', '2N-3']) {
      expect(table.rows.find((r) => r.id === id)?.reasons, `${id} 没报规则三`).toContain(
        'burden_on_other_side',
      );
    }
  });

  it('🔴 档位只从**过了判定的那条**里取：一条带书证的调岗通知抬不动它（变异：从全部同类事件里取最强档 → 红）', () => {
    // 【这条最贵】用户把调岗通知的原件传了上来（书证档），另有一条自述的"HR 口头说要解除"。
    // 从全部同类事件里取最强档的形态是：这个槽显示成书证档 ⇒ 三条写着「成立」，
    // 而那份书证证的是调岗，不是解除决定。
    const over: FactsOver = {
      evidence: [{ category: '公司文件' }],
      timeline: [
        { kind: '公司动作', source_tier: '书证', title: '通知我调岗到保定分公司' },
        { kind: '公司动作', source_tier: '自述', title: 'HR 通知我解除劳动合同' },
      ],
    };
    for (const id of DECISION_CARDS) {
      expect(rowOf(id, over).status, `${id} 被调岗那份书证抬到了「成立」`).toBe('成立·待证');
    }
  });

  it('(d) 词表：认的那 18 种说法（变异：删掉正向词表里任一类 → 红）', () => {
    for (const raw of [
      DECISION_EVENT,
      '收到《解除劳动合同通知书》',
      'HR 通知我解除劳动合同，理由写的是绩效',
      '单位把我辞退了',
      '老板当场开除我',
      '公司决定解聘，明天办交接',
      '公司通知劳动合同到期终止，不再续签',
      '公司通知合同到期不再续签',
      'HR 口头通知我被裁了',
      // 【它守什么】「准备 / 计划 / 考虑」这些未定态词在**已经解除之后**同样常见。
      // 整条一命中就排的形态是：一个手上正拿着解除通知书的人，三条要件写着「缺失」，
      // 清单让他去补那份他已经收到的纸。（变异：未定态那条不要求紧挨着决定动作 → 红）
      '公司送达《解除劳动合同通知书》，让我准备交接',
      // 【下面四条守"排得太多"那一侧】（第四轮复审第二条）2N 案子最常见的叙事就是
      // 「先谈、谈崩、公司单方解除」。整条一见「协商」就排的形态是：这几条全落「缺失」，
      // 清单让用户去记一条他刚刚记下的事件，而那份真在档的《解除通知书》连规则三都触发不了。
      // 同理"否定词/条件词落在别处"的那两条——它们说的都是已经发生的事。
      '协商不成，公司单方解除了劳动合同',
      '我拒绝签协商解除协议后，公司直接发了解除通知书',
      // 【这两条钉的是词形，不是小句】它们把「协商」与那个决定写在**同一小句**里，
      // 所以按小句判也救不了；只有把协商类收成「协商解除 / 协商一致」这种指向那份协议本身
      // 的说法（并把「未经协商解除」摘出去），它们才认得出来。
      '未经协商解除劳动合同，补偿一分没提',
      '协商未果后公司单方解除了劳动合同',
      '公司没有提前通知就把我辞退了',
      // 【签收 ≠ 催签】「让我签」那一格认的是催签协议；而「让我签收〈解除通知书〉」
      // 递过来的正是那份决定本身，方向完全相反。（变异：让我签那一格不摘出「签收」→ 红）
      'HR 让我签收《解除劳动合同通知书》',
      // 【文书名本身就是决定形态】（第五轮复审第五条，2026-09-10）未定态排除作废的只是
      // **它所在的那一小句**，不作废文书名所在的那一小句：前半句是"说要"，后半句那份纸
      // 已经送到手上了。（变异：未定态那条退回整条一命中就排 → 红）
      '说要辞退我，下午就送达了解除劳动合同通知书',
      // 【这一条才是压着文书名那格的】上一条的「解除劳动合同通知书」里嵌着决定动词「解除」，
      // 有没有文书名那格都认得出。而决定动作表这一轮收掉了光杆「裁员」，
      //「裁员通知书」因此成了一份**没有决定动词**的文书——一张已经送到手上的纸。
      '公司送达了裁员通知书',
    ]) {
      const row = rowOf('N-2a', withCompanyAction(raw));
      expect(row.status, `「${raw}」（这是公司作出的解除决定）被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('(d) 词表：不认的那 23 种说法，一律落「缺失」并点名（变异：判定放宽到"有记录就算" → 红）', () => {
    // 【为什么反样本比正样本多】认不准时一律判"不算"：漏判只是让用户多读一行"该补什么"，
    // 误判会让一个还没被解除的人以为这几项已经立住，并去固定一份不存在的书面决定。
    // 前十条是施压期的日常动作，中间三条**带着「解除/裁员」这些词但还没定**，
    // 最后两条是协商类——协商不是单方决定（经理裁定）。
    for (const raw of [
      '通知我调岗到保定分公司',
      '宣布下月起降薪 30%',
      'HR 约谈，暗示我主动走',
      '发了一份书面警告',
      '通知全员搬办公室',
      '通知我停工待岗',
      '下发新版员工手册，要求签收',
      '绩效被突然打最低档',
      '启动 30 天 PIP，目标含"显著提高沟通能力"等模糊项',
      '年会通知：下周五团建',
      '公司说要裁员，还没通知到我',
      '传闻公司下月裁员',
      '老板放话可能要解除一批人',
      'HR 递来《协商解除协议》，补偿写 N',
      'HR 催签协商解除协议（当时未签）',
      // 【下面八条是第四轮复审第一条实测出来的那一批】施压期真实的约谈记录几乎必带
      // 「不…就辞退/解除」这一句。上一版要求未定态词与决定动作隔不过 4 个字，
      // 而条件从句正好把它们撑开，于是词表里明明写着的「威胁 / 暗示」一次都没生效。
      'HR 威胁说要是不同意降薪就解除劳动合同',
      '领导暗示不走就会被开除',
      'HR 约谈，说不签调岗协议就按旷工辞退',
      'HR 约谈，暗示我主动走，否则公司会解除劳动合同',
      '公司说不会辞退我，只是调岗',
      'HR 说公司暂时没有解除的打算',
      '公司群发裁员补偿方案让大家自愿报名',
      // 方向反了：「被迫解除」是我发的那一份，公司只是签收（判定归 forcedTerminationNotice）
      '公司签收了我的被迫解除通知书',
    ]) {
      const row = rowOf('N-2a', withCompanyAction(raw));
      expect(row.status, `「${raw}」（这不是公司作出的解除决定）被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual([N2A_ACTION_MISSING]);
    }
  });

  it('🔴 光杆「裁员 / 末位淘汰」不是已作出的决定（变异：把光杆「裁员|末位淘汰」放回决定动作表 → 全红）', () => {
    // 【它守什么】（第五轮复审第二条，2026-09-10）「裁员」「末位淘汰」说的是**公司的一项
    // 动作或制度**，不是"这个人已经被解除了"。而风声起、还没轮到自己，正是核心客户窗口里
    // 最典型的那一份档案——判成「成立·待证」的后果是三层，每一层都读得通：
    // 三张卡一起抬起来 ⇒ N-2a 成了组代表行 ⇒ 规则三让他去固定一份还不存在的书面决定。
    // 末一条守的是另一种主语：决定动作是真的，只是它落在别人头上。
    for (const raw of [
      '公司宣布裁员 20%，还没找我谈',
      '公司在裁员，但我不在名单里',
      '公司启动裁员，暂时没轮到我',
      'HR 约谈说末位淘汰，让我自己考虑',
      // 【末三条：决定动作落在别人头上】收窄成「人称词 + 被」之后，这三种主语照旧排掉：
      // 光杆人称词（同事 / 别人）、带定语的人称词（我同事 = 我的同事，不是"我和同事"）。
      // （变异：把这一格改回裸词「同事|同组|其他人|别人|他人」→ 下一条那七例全红）
      '同事被辞退了，我很担心',
      '别人被裁了',
      '我同事被裁了，我很担心',
    ]) {
      for (const id of DECISION_CARDS) {
        const row = rowOf(id, withCompanyAction(raw));
        expect(row.status, `「${raw}」（还没作出决定）把 ${id} 抬成了 ${row.status}`).toBe('缺失');
        expect(row.missingSlots, `「${raw}」在 ${id} 上的缺口没点名`).toEqual([actionMissingFor(id)]);
      }
    }
  });

  it('🔴 反臂：落到本人头上的那几种「裁」照旧认（变异：裁员那半只留「被裁」一格 → 全红）', () => {
    // 【为什么这条必须并排放着】上一条的修法是"收窄裁员"。收过头的形态与判错方向一样贵：
    // 一个真被裁掉的人，三条要件写着「缺失」，清单让他去记一条他刚刚记下的事件。
    for (const raw of ['公司把我裁了', '公司裁掉了我', '公司通知我被末位淘汰', '裁员名单里有我']) {
      const row = rowOf('N-2a', withCompanyAction(raw));
      expect(row.status, `「${raw}」（这个人已经被裁了）被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('🔴 别人只是写在事由或名单里，那个决定照旧认（变异：⑦改回裸词「同事|其他人|他人」→ 全红）', () => {
    // 【它守什么】（经理裁决，2026-09-10 台账「公司动作」票）排除项⑦上一版是几个裸词，
    // 一见「同事 / 其他人 / 他人」就把那一小句作废。而这些词在真档案里**大多不是主语**：
    // 打架、辱骂、泄露他人信息——它们是公司写在解除通知上的**事由**；
    //「我和其他人一起被裁」「我和另外两个同事」——这个人自己就在名单里；
    //「当着其他同事的面」——别人只是在场。整类判成「缺失」的形态是：一个手上正拿着
    // 解除通知书的人，三条要件写着缺，清单让他去记一条他刚刚记下的事件。
    // 末一条与 N-2a 的反样本「同事和我」互为镜像：夹在人称词与「被」之间的那个「我」，
    // 说的是这个人也在被裁的那一批里。
    for (const raw of [
      '公司以我和同事打架为由开除了我',
      '公司以我辱骂同事为由辞退我',
      '因为和同事吵架公司开除了我',
      '公司以泄露他人信息为由解除劳动合同',
      '公司通知我和其他人一起被裁',
      '公司辞退了我和另外两个同事',
      'HR 当着其他同事的面通知我被辞退',
      '同事和我一起被裁了',
    ]) {
      for (const id of DECISION_CARDS) {
        const row = rowOf(id, withCompanyAction(raw));
        expect(row.status, `「${raw}」（这是公司作出的解除决定）在 ${id} 上被判成了 ${row.status}`).toBe(
          '成立·待证',
        );
      }
    }
  });

  it('🔴 发给"我们"的那份通知不是送到这个人手上（变异：送达词「给我」不摘出「给我们」→ 全红）', () => {
    // 【它守什么】（经理裁决，2026-09-10 台账「公司动作」票）「裁员通知书」里没有决定动词，
    // 它是靠"文书名 + 已经送到"这条路算数的（见 COMPANY_DECISION_DOC）。于是送达词里那个
    //「给我」把**群发给全员**的那一份也认成了送到这个人手上的纸——与"面向全员的方案"
    // 同一件事，只是走的另一条路：风声刚起、通知发到大群里，三张卡就一起抬成「成立·待证」。
    for (const raw of ['公司发了裁员通知给我们全体', '公司群发裁员通知给我们']) {
      for (const id of DECISION_CARDS) {
        const row = rowOf(id, withCompanyAction(raw));
        expect(row.status, `「${raw}」（发给全员，不是送到这个人手上）把 ${id} 抬成了 ${row.status}`).toBe(
          '缺失',
        );
        expect(row.missingSlots, `「${raw}」在 ${id} 上的缺口没点名`).toEqual([actionMissingFor(id)]);
      }
    }
  });

  it('🔴 反臂：真送到手上的那份照旧认（变异：送达词把「给我」整个删掉 → 红）', () => {
    // 【为什么这条必须并排放着】上一条的修法是"给我"摘出"给我们"。摘过头的形态与判错方向
    // 一样贵：一份已经递到手上的《终止劳动合同通知书》判成「缺失」。
    // 【末一条才是压着「给我」这一格的】前两条里「终止」是决定动词、「送达」是另一个送达词，
    // 拆掉「给我」它们照旧认得出；只有"裁员通知书 + 给我"这一种——文书里没有决定动词、
    // 送到手上只写了「给我」——整条压在这一格上。（实测：不放它，把「给我」整个删掉仍全绿）
    for (const raw of ['公司送达了裁员通知书', '给我终止劳动合同通知书', '公司把裁员通知书给我了']) {
      const row = rowOf('N-2a', withCompanyAction(raw));
      expect(row.status, `「${raw}」（这份纸已经送到手上了）被判成了 ${row.status}`).toBe('成立·待证');
    }
  });

  it('标题与详情之间那个换行是小句边界（变异：换行照旧当空白抹掉 → 红）', () => {
    // 【它守什么】（第五轮复审第四条，2026-09-10）checkableEntries 特意在标题与详情之间
    // 放了一个换行，好让判定自己决定要不要把两段字当一句连续的话读。抹掉它的形态是——
    // 标题末尾与详情开头凑出一句谁都没写过的话：「领导暗示」+「公司送达了《解除劳动合同
    // 通知书》」被读成一句「领导暗示公司送达了…」，未定态那条把整句排掉，
    // 一份已经拿到手的解除通知书判成「缺失」。
    const row = rowOf('N-2a', {
      evidence: [{ category: '公司文件' }],
      timeline: [
        {
          kind: '公司动作',
          source_tier: '自述',
          title: '领导暗示',
          detail: '公司送达了《解除劳动合同通知书》',
        },
      ],
    });
    expect(row.status, `换行没当成小句边界，这条被判成了 ${row.status}`).toBe('成立·待证');
  });

  it('🔴 施压期那条约谈记录不许抬起三张卡，也不许触发规则三（变异：未定态退回"隔不过 4 字"的邻接窗口 → 红）', () => {
    // 【为什么这条要单独摆一遍】上一条只看 N-2a 的状态；本票要根治的那一格是**三张卡一起
    // 抬起来 + 规则三跟着触发**，所以这里把那三层一次钉死，用的是真实约谈记录的写法。
    const over = withCompanyAction('HR 约谈，说不签调岗协议就按旷工辞退，还威胁说下周就解除劳动合同');
    for (const id of DECISION_CARDS) {
      const row = rowOf(id, over);
      expect(row.status, `${id} 被一条威胁式的约谈记录抬成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `${id} 的缺口没点名那条解除决定`).toEqual([actionMissingFor(id)]);
      expect(row.unresolvedSlots, `${id} 有认不出来的槽位`).toEqual([]);
    }
    const onFile = counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over));
    expect(onFile, '一条威胁式的约谈记录就让"对方那份书面决定在档"成立了').toBe(false);
    const sheet = sheetOf(over);
    const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile }, sheet.rendered);
    for (const id of DECISION_CARDS) {
      expect(table.rows.find((r) => r.id === id)!.reasons, `${id} 报了规则三`).toEqual(['element_unsettled']);
    }
  });

  it('🔴 反臂：协商谈崩后那份真在档的解除决定照旧在档（变异：协商类整条一命中就排 → 红）', () => {
    // 【它守什么】（第四轮复审第二条）与上一条并排放着：收窄不许连"协商不成 → 公司单方解除"
    // 一起误杀。判成「缺失」的后果与判错方向一样贵——用户手上正拿着那份《解除通知书》，
    // 三条要件却写着缺，规则三对一份真在档的书面决定不触发。
    const over = withCompanyAction('协商不成，公司单方解除了劳动合同', '书证');
    for (const id of DECISION_CARDS) {
      expect(rowOf(id, over).status, `${id} 到不了「成立」`).toBe('成立');
    }
    expect(
      counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over)),
      '真在档的《解除通知书》被"协商"二字判成了不在档',
    ).toBe(true);
  });

  it('detail 那段字也算数：标题只写「收到公司来函」，内容写在详情里', () => {
    const row = rowOf('N-2a', {
      evidence: [{ category: '公司文件' }],
      timeline: [
        {
          kind: '公司动作',
          source_tier: '自述',
          title: '收到公司来函',
          detail: '内容是解除劳动合同，理由写的是不能胜任工作',
        },
      ],
    });
    expect(row.status).toBe('成立·待证');
  });
});

// ══ 公司一侧词表一份共用并扩词（2026-09-10 台账「公司动作」票第二条）══
describe('N-2b 方向：公司一侧的部门名 / 职务名 / 合同称谓也算主语', () => {
  // 【它守什么】复审实测：五条公司解除叙事被判成"我方发出了被迫解除通知"，
  // 全部卡在主语那个词不在词表里（人力资源部 / 法务 / 总经理 / 甲方 / 用人单位）。
  // 判错的后果与那 22 例同款：路径二被抬起来（用户不去准备那份通知、不去固定欠薪的
  // 初步证明），而他真正该走的路径一被同组的代表行盖住——两个错都读起来很顺。
  const withMyAction = (title: string) =>
    buildElementSheet(
      {
        case: {
          employed_from: '2020-03-01',
          position: '后端工程师',
          monthly_wage_fen: 2_500_000,
          contract_count: '续签过一次',
        },
        claims: [{ kind: 'N', source_tier: '自述' }],
        companies: [{ role: '签约主体', source_tier: '自述' }],
        evidence: [{ category: '沟通记录' }],
        timeline: [{ kind: '我方动作', source_tier: '自述', title, detail: null, event_type: null }],
      },
      LABOR.elementCards ?? [],
      ['N'],
    ).rows.find((r) => r.id === 'N-2b')!;

  it('🔴 五条公司解除叙事一条都不认（变异：词表退回旧闭集「公司|HR|单位|老板|人事」→ 全红）', () => {
    for (const raw of [
      '公司人力资源部向我送达了解除劳动合同通知书，工资拖欠三个月',
      '公司的法务部同事发送了解除劳动合同通知书，欠薪没结',
      '公司法务今天上午给我发出解除通知，欠薪未结',
      '总经理提出解除劳动合同，拖欠工资没给',
      '甲方发出解除劳动合同通知书，拖欠工资',
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（是公司解除的）被判成了 ${row.status}`).toBe('缺失');
    }
  });

  it('🔴 反臂：同一批新词做收件人时照旧算我发的（变异：不认词前面那个介词 → 红）', () => {
    // 【为什么这条必须并排放着】上一条的修法是"把这些词加进公司一侧"。若只加词、
    // 不问它在句子里是主语还是收件人，这些——用户手上正拿着回执的那一类——会反向误杀。
    for (const raw of [
      '公司欠薪，我给领导发了被迫解除通知书',
      '向用人单位邮寄被迫解除劳动合同通知书并留存回执',
      '因拖欠工资，向人力资源部发送解除劳动合同通知',
      '已向总经理提交被迫解除劳动合同通知书',
      '公司欠薪我发出被迫解除通知书',
      // 【第四轮复审第三条】词表扩入职务名之后新开的那道缝：「经理」落进公司一侧的主语短语，
      // 而第一人称在更前面的「我作为」处看不见，于是这条我发的通知被判成公司作出的解除。
      '公司欠薪，我作为部门经理也发出了被迫解除通知书',
      // 【为什么同一条要再来一遍不带「被迫」的】上面那条写着「被迫解除」，公司解除那条里
      // 新加的「被迫」守卫已经先把它摘出去了——于是「我作为〈职务〉」那道排除删掉也不红。
      // 走⑧的这一条没有那四个字，压着的正是那道排除。
      '公司拖欠工资，我作为部门经理发出了解除劳动合同通知书',
    ]) {
      expect(withMyAction(raw).status, `「${raw}」（这是我发的）被判成了 ${withMyAction(raw).status}`).toBe(
        '成立·待证',
      );
    }
  });

  it('🔴 收件人写全称（公司 + 部门）照旧算我发的（变异：删掉主语排除项里那条收件人前缀 → 全红）', () => {
    // 【它守什么】（第五轮复审第一条，2026-09-10）上一版的收件人排除只看紧挨着公司词的
    // 那**一个**字，于是"收件人写全称"的那一整类两个方向同时判反：介词管的是前面那个
    //「公司 / 用人单位」，而「人力资源部」自己前面挨着的是「司 / 的 / 位」——
    // 它落进公司一侧的主语短语，一边把发出动词挡在主语短语后面（我方发出认不出来），
    // 一边让公司解除那条把「人力资源部发出被迫解除」读成公司作出的决定。
    // 判错的后果：用户手上正拿着 EMS 回执，路径二写着「缺失」，清单让他去补那份他已经寄出的纸。
    for (const raw of [
      '因拖欠工资，向公司人力资源部发出被迫解除劳动合同通知书',
      '公司欠薪，给公司的人力资源部发了被迫解除通知书',
      '因拖欠工资，向公司人力资源部门发送被迫解除劳动合同通知书',
      '已向用人单位人力资源部邮寄被迫解除劳动合同通知书',
      // 【这两条才是压着那道收件人前缀的】上面四条写着「被迫解除」四个字，它们另有一条认法
      //（⑤）兜底；不写那四个字的通知走的是⑧——事由 + 解除动作 + **那个动作是我方发出的**，
      // 而"我方发出"恰恰要靠这道排除才认得出来。
      '因拖欠工资，向公司人力资源部发送解除劳动合同通知',
      '公司欠薪，给公司的人力资源部寄出解除劳动合同通知书',
    ]) {
      expect(withMyAction(raw).status, `「${raw}」（这是我发的）被判成了 ${withMyAction(raw).status}`).toBe(
        '成立·待证',
      );
    }
  });

  it('🔴 没有"公司被迫解除"这回事（变异：去掉公司解除那条里的「被迫」守卫 → 红）', () => {
    // 【为什么这条要单独摆着】上一条的修法管的是"公司词前面有没有介词"。而拒收 / 拒签这一类
    // 记录里那个公司词**真的是主语**（是它在拒收），公司词 + 十字内的「解除」照样凑得出
    // 一条公司解除，于是④把一份真寄出去的通知判成公司作出的决定。「被迫解除」是第三十八条
    // 那件事在本行当的固定说法，只可能是我方那一份。
    const raw = '公司人力资源部拒收被迫解除劳动合同通知书';
    expect(withMyAction(raw).status, `「${raw}」（是我发的那一份）被判成了 ${withMyAction(raw).status}`).toBe(
      '成立·待证',
    );
  });
});

// ══ FORCED_CAUSE 口语化（2026-09-10 台账「公司动作」票第三条）══
describe('第三十八条那两项事由：口语说法也取得到', () => {
  // 【它守什么】上一版只认书面语（拖欠 / 欠薪 / 克扣 / 未足额支付 / 未缴纳社保）。
  // 用户在时间线上写的是「工资一直没发」「还欠着两个月工资」「社保一直没交」——
  // 一个字都取不到事由，于是⑧那条判不过，一份真发过被迫解除通知的档案落「缺失」，
  // 清单让他去补一份他已经寄出去的通知书。
  const withMyAction = (title: string) =>
    buildElementSheet(
      {
        case: {
          employed_from: '2020-03-01',
          position: '后端工程师',
          monthly_wage_fen: 2_500_000,
          contract_count: '续签过一次',
        },
        claims: [{ kind: 'N', source_tier: '自述' }],
        companies: [{ role: '签约主体', source_tier: '自述' }],
        evidence: [{ category: '沟通记录' }],
        timeline: [{ kind: '我方动作', source_tier: '自述', title, detail: null, event_type: null }],
      },
      LABOR.elementCards ?? [],
      ['N'],
    ).rows.find((r) => r.id === 'N-2b')!;
  /** 事由 + 一句"我发出了解除通知"（走的是⑧：事由 + 解除动作 + 我方发出，三样都要）。 */
  const sent = (cause: string) => withMyAction(`${cause}，我发出解除劳动合同通知书`);

  it('认的那 17 种口语事由（变异：把扩进去的口语形态删掉 → 全红）', () => {
    for (const cause of [
      '工资一直没发',
      '工资两个月没结',
      '工资至今没给',
      '还欠着两个月工资',
      '欠着工资',
      '社保一直没交',
      '社保从来没缴',
      '没交社保',
      '没给我交社保',
      '没发工资',
      // 【第四轮复审第四条】两个方向此前不对称：社保那半有「给我」那一格、工资那半没有，
      // 而「不给发」这个最口语的否定形态两边都取不到。
      '没给我发工资',
      '一直不给发工资',
      '社保不给交',
      // 【第五轮复审第三条，2026-09-10】口语里最常见的「没有」整类此前取不到事由：
      // 否定词与那个动词之间只放行「给 / 给我」，多一个"有"字就判不出来。
      '工资没有发',
      '工资一直没有发',
      '社保没有交',
      '公司没有给我交社保',
    ]) {
      expect(sent(cause).status, `「${cause}」取不到事由，被判成了 ${sent(cause).status}`).toBe('成立·待证');
    }
  });

  it('🔴 不认的那 7 种（没有否定词就不是欠薪；变异：把否定词那一格去掉 → 全红）', () => {
    for (const cause of [
      // 【双重否定不是事由】（第四轮复审第四条）「工资…不…发」三样都在，
      // 而这句话说的正好相反。（变异：事由词与否定词之间放行否定词 → 红）
      '公司说工资不会不发',
      '工资下月发',
      '公司说会补社保',
      '工资照发',
      '社保一直正常缴纳',
      '工资按时到账',
      '已经补发了工资',
    ]) {
      expect(sent(cause).status, `「${cause}」不是第三十八条那两项事由，却被认了`).toBe('缺失');
    }
  });
});

describe('「公司确实作出过那个决定」四处同源（第四轮复审 2026-09-10）', () => {
  // 【它守什么】2N-2、2N-3、N-2a 与本包的 counterpartyDecisionSlot 判的是**同一件事**，
  // 而这对槽此前在四处各写一遍字面量，收窄又是分三轮做的——2N-2 就是漏掉的那一处：
  // 三处都要「公司文件 + 公司动作」了，它还只认「公司文件」。漏掉的那一处不红、不报错，
  // 它旁边判同一件事的 2N-3 判得好好的，两行并排放着，一行对一行错。
  const factsWith = (over: FactsOver = {}): ElementFactsView => ({
    case: {
      employed_from: '2020-03-01',
      position: '后端工程师',
      monthly_wage_fen: 2_500_000,
      contract_count: '续签过一次',
    },
    claims: [{ kind: '2N', source_tier: '自述' }],
    companies: [{ role: '签约主体', source_tier: '自述' }],
    evidence: [],
    ...over,
    timeline: timelineOf(over),
  });
  const rowOf = (id: string, over: FactsOver = {}) =>
    buildElementSheet(factsWith(over), LABOR.elementCards ?? [], ['2N']).rows.find((r) => r.id === id)!;

  it('🔒 四处取值逐字相同（变异：把其中任一处改回单槽、或再内联一份字面量 → 红）', () => {
    const card = (id: string) => (LABOR.elementCards ?? []).find((c) => c.id === id)!;
    const pack = LABOR.counterpartyDecision;
    expect(pack, 'counterpartyDecision 没声明').toBeTruthy();
    expect([...(pack?.slots ?? [])], 'counterpartyDecision.slots 是空的').not.toEqual([]);
    // 【为什么钉的是取值而不是"都引用了那个常量"】常量是不是被引用，判据看不见——
    // 能看见的只有取值。四处取值相等，就把"再内联一份字面量"与"改了一处忘了另外三处"
    // 一起挡在门外：那两种做法都会让下面这几行里的某一行对不上。
    for (const id of ['2N-2', '2N-3', 'N-2a']) {
      expect([...card(id).satisfiedBy], `${id} 与本包的 counterpartyDecision 对不上`).toEqual([
        ...(pack?.slots ?? []),
      ]);
      // 【判定也要同源】（2026-09-10「公司动作」票）只对齐槽的形态是：卡片过判定、
      // 规则三只数记录，于是要件表说「缺失」而正文让他去固定那份不存在的决定。
      expect(
        card(id).slotChecks?.[COMPANY_ACTION_SLOT]?.accepts,
        `${id} 的「公司动作」判定不是本包声明的那一个`,
      ).toBe(pack?.slotChecks?.[COMPANY_ACTION_SLOT]?.accepts);
    }
  });

  it('只有一份「公司文件」**不能**把 2N-2 抬成「成立」（变异：2N-2 改回单槽 → 红）', () => {
    // 风闻裁员、还没收到任何解除通知、先把员工手册传上来的那个人：
    // 「公司单方解除或终止了劳动合同」当场写着「成立」，而他手上一份解除通知都没有。
    const only = { evidence: [{ category: '公司文件' }] };
    const row = rowOf('2N-2', only);
    expect(row.status, `只有一份公司文件时 2N-2 被判成了 ${row.status}`).toBe('缺失');
    expect(row.missingSlots, '缺口没点到"公司确实作出过这个决定"那条记录').toContain(COMPANY_ACTION_MISSING);
  });

  it('公司文件 + 那条「公司动作」 ⇒ 2N-2 成立；事件只有自述时天花板是「成立·待证」', () => {
    // 【为什么两档都要钉】只钉「成立」那一格，把新槽写成恒 true 也是绿的；
    // 只钉「成立·待证」，两个槽取最强档（而不是最弱）同样绿。
    expect(
      rowOf('2N-2', {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '书证', title: DECISION_EVENT }],
      }).status,
    ).toBe('成立');
    expect(
      rowOf('2N-2', {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '自述', title: DECISION_EVENT }],
      }).status,
      '事件只有当事人自己说，这一条就到不了「成立」',
    ).toBe('成立·待证');
  });

  it('只有那条「公司动作」、公司那份文件不在档 ⇒ 2N-2 仍是「缺失」，且缺口点名那份文件', () => {
    // satisfiedBy 是「与」不是「或」：新加一个槽不许把原来那个槽变成可选。
    const row = rowOf('2N-2', {
      timeline: [{ kind: '公司动作', source_tier: '书证', title: DECISION_EVENT }],
    });
    expect(row.status).toBe('缺失');
    expect(row.missingSlots).toContain('evidence:公司文件');
  });
});

// ══ 结构化「决定」标记（2026-09-10/11 台账「结构化决定」票）══
/**
 * **登记时选过的类型压过谓词**：labor 这一侧的两个方向。
 *
 * 【它守什么】前面那几组（「公司动作」「我方动作」的词表用例）钉的是**谓词**：
 * 用户没说清这条记录是什么时，靠那段字去认。五轮下来每一轮都还有新的漏网——
 * 而那正是本票要绕开的那条路：让登记的人自己说。这一组钉的是"说了就算，不再猜"，
 * 且**两个方向都钉**：
 *   · 含糊到任何谓词都认不出来的一句话 + 对的类型 ⇒ 三张卡抬起来、规则三触发；
 *   · 写满谓词认得的词的一句话 + 别的类型 ⇒ 三张卡照旧「缺失」、规则三不触发。
 * 只钉前一个方向的形态是：把判定改成"类型或谓词任一命中即过"，它照样绿——
 * 而那种改法等于类型形同虚设。
 *
 * 【回落那一组在哪】前面所有词表用例的时间线行都不带类型（夹具默认 event_type: null），
 * 它们整体就是"没类型 ⇒ 回落到谓词"那一臂；下面第一条把这个前提本身钉住，
 * 免得哪天夹具默认值改了，那几十条用例悄悄变成在测别的东西。
 */
describe('结构化「决定」标记：选过类型就不猜', () => {
  const factsWith = (over: FactsOver = {}): ElementFactsView => ({
    case: {
      employed_from: '2020-03-01',
      position: '后端工程师',
      monthly_wage_fen: 2_500_000,
      contract_count: '续签过一次',
    },
    claims: [
      { kind: 'N', source_tier: '自述' },
      { kind: '2N', source_tier: '自述' },
    ],
    companies: [{ role: '签约主体', source_tier: '自述' }],
    evidence: [],
    ...over,
    timeline: timelineOf(over),
  });
  const rowOf = (id: string, over: FactsOver = {}) =>
    buildElementSheet(factsWith(over), LABOR.elementCards ?? [], ['N', '2N']).rows.find((r) => r.id === id)!;
  const onFile = (over: FactsOver) => counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over));
  const DECISION_CARDS = ['N-2a', '2N-2', '2N-3'] as const;
  /** 员工手册（「公司文件」类）+ 一条带类型的「公司动作」。 */
  const companyAction = (title: string, eventType: string | null, tier = '自述'): FactsOver => ({
    evidence: [{ category: '公司文件' }],
    timeline: [{ kind: '公司动作', source_tier: tier, title, event_type: eventType }],
  });

  it('🔒 地板：前面那几十条词表用例确实一条类型都没带（夹具默认值变了 → 红）', () => {
    expect(timelineOf({ timeline: [{ kind: '公司动作', source_tier: '自述' }] })[0].event_type).toBeNull();
  });

  it('🔒 地板：那格判定真的挂着 acceptsType，且 N-2a 只比另外三处多认协商那一格（去掉 / 多给一格 → 红）', () => {
    // 【为什么这一条要逐处写死、而不是"四处相等"】（2026-09-11 台账「协商一致解除」票）
    // 四处此前确实同值，而这一票让 N-2a **多认一种类型**：协商一致解除是第四十六条第二项
    // 那一档经济补偿，2N（违法解除赔偿金）与规则三的举证倒置都不该跟着成立。
    // 写成"四处相等"的形态是：这道地板要么把本票的裁定判红、要么被顺手改成"谁都不管"，
    // 而把协商那一格误加进 2N-2 / 2N-3 / counterpartyDecision 的改动从此没有人会红。
    const n2a = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2a')!;
    expect(n2a.slotChecks?.[COMPANY_ACTION_SLOT]?.acceptsType, 'N-2a 没有认下协商解除那一格').toEqual([
      'company_termination',
      'company_negotiation',
    ]);
    for (const id of ['2N-2', '2N-3'] as const) {
      const card = (LABOR.elementCards ?? []).find((c) => c.id === id)!;
      expect(
        card.slotChecks?.[COMPANY_ACTION_SLOT]?.acceptsType,
        `${id} 的「公司动作」类型判定不是"只认公司单方作出的那个决定"`,
      ).toEqual(['company_termination']);
    }
    expect(
      LABOR.counterpartyDecision?.slotChecks?.[COMPANY_ACTION_SLOT]?.acceptsType,
      '规则三（举证倒置）跟着认了协商解除',
    ).toEqual(['company_termination']);
    const n2b = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2b')!;
    expect(n2b.slotChecks?.['timeline:我方动作']?.acceptsType).toEqual(['my_forced_termination_notice']);
  });

  it('🔴 含糊文本 + company_termination ⇒ 三张卡抬起来、规则三触发（变异：去掉类型优先 → 红）', () => {
    // 「上周三那个事」——谓词一个决定动词都认不出来，而登记的人已经说了它是哪一格。
    const over = companyAction('上周三那个事', 'company_termination');
    for (const id of DECISION_CARDS) {
      expect(rowOf(id, over).status, `${id} 没有按类型认下来`).toBe('成立·待证');
      expect(rowOf(id, over).missingSlots).toEqual([]);
    }
    expect(onFile(over), '事件只有自述档 ⇒ 那张纸还不算在档（门槛②不变）').toBe(false);
    // 由《解除通知》一类材料提取写入（书证档）⇒ 「成立」，规则三这才触发
    const doc = companyAction('上周三那个事', 'company_termination', '书证');
    expect(rowOf('2N-2', doc).status).toBe('成立');
    expect(onFile(doc)).toBe(true);
  });

  it('🔴 带「解除」字样 + company_notice ⇒ 仍是「缺失」，谓词不再跑（变异：改成"任一命中即过" → 红）', () => {
    // 这一句谓词认得（「公司送达《解除劳动合同通知书》」是它的头号正样本），
    // 但登记的人把它选成了「其他通知」。当他没说的形态是：系统按几个词覆盖掉本人的判断。
    const over = companyAction(DECISION_EVENT, 'company_notice', '书证');
    for (const id of DECISION_CARDS) {
      const row = rowOf(id, over);
      expect(row.status, `${id} 被谓词绕过类型抬成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots).toEqual([actionMissingFor(id)]);
    }
    expect(onFile(over)).toBe(false);
  });

  it('N-2a 的出路里说得出"已经签完字了怎么办"（禁令配出路，§7.7）', () => {
    // 协商一致解除是第四十六条第二项那一档，而它由 company_negotiation 承载、不由
    // company_termination 承载。不说的形态是：一个已经签完协议的人读到「缺失」，
    // 而清单从头到尾只在讲解除通知书。
    const card = (LABOR.elementCards ?? []).find((c) => c.id === 'N-2a')!;
    const line = card.typicalEvidence.find((e) => e.includes('协商一致'));
    expect(line, 'N-2a 的出路里没有一句讲协商一致解除').toBeTruthy();
    // 那句话要同时说清三件事：把已签的那份登记为证据、事件那一格选哪个类型、没签的不算。
    expect(line).toContain('协商解除提议或协议');
    expect(line).toContain('公司文件');
    expect(line, '没说清"还没签的那一份不算"').toContain('还没签');
    // 缺口那一行（用户真正读到的那一句）同样要带着这条出路，不是只报个名字。
    const missing = card.slotChecks?.[COMPANY_ACTION_SLOT]?.missingAs ?? '';
    expect(missing, '缺口那一行没讲协商一致解除怎么办').toContain('协商解除提议或协议');
    expect(missing).toContain('时间线事件');
    // 登记面上那一格的 hint 也要说得出"没签的不算"——签没签在类型上分不开，
    // 这句话是登记时唯一说得清它的地方。
    const negotiation = LABOR.timelineEventTypes['公司动作'].find((t) => t.id === 'company_negotiation')!;
    expect(negotiation.hint ?? '', 'company_negotiation 的 hint 没说清"没签的不算"').toContain('还没签');
  });

  it('🔴 我方动作同款双向：含糊 + 对的类型 ⇒ 过；写着「被迫解除」+ 异议函 ⇒ 不过', () => {
    const n2b = (over: FactsOver) =>
      buildElementSheet(
        {
          case: {
            employed_from: '2020-03-01',
            position: '后端工程师',
            monthly_wage_fen: 2_500_000,
            contract_count: '续签过一次',
          },
          claims: [{ kind: 'N', source_tier: '自述' }],
          companies: [{ role: '签约主体', source_tier: '自述' }],
          evidence: [{ category: '沟通记录' }],
          timeline: timelineOf(over),
        },
        LABOR.elementCards ?? [],
        ['N'],
      ).rows.find((r) => r.id === 'N-2b')!;

    expect(
      n2b({
        timeline: [
          { kind: '我方动作', source_tier: '自述', title: '上周寄出去那份', event_type: 'my_forced_termination_notice' },
        ],
      }).status,
    ).toBe('成立·待证');
    const wrong = n2b({
      timeline: [
        { kind: '我方动作', source_tier: '书证', title: '发出被迫解除劳动合同通知书', event_type: 'my_objection' },
      ],
    });
    expect(wrong.status, '谓词绕过了本人选的类型').toBe('缺失');
  });

  it('🔒 首诊那段整段自述落成 my_other ⇒ 照旧不参与判定（沿用裁定）', () => {
    // 落地前靠标题字串把它摘出去（forcedTerminationNotice 的⓪，那道仍管着存量行）；
    // 新行连谓词都不必跑——两条路都要通向同一个答案。
    expect(LABOR.intakeEventType?.({
      source: 'freeText',
      kind: '我方动作',
      title: LABOR.copy.site.intakeFreeTextTitle,
      answers: {},
    })).toBe('my_other');
  });
});

// ══ 协商一致解除（2026-09-11 台账「协商一致解除」票）══
/**
 * **协商一致解除只抬 N，不抬 2N、不触发举证倒置。**
 *
 * 【它守什么】此前 `company_negotiation` 一处都不计入：一个已经协商一致签完字的人，
 * N-2a「公司作出的解除/终止决定（第四十六条第二至七项）」写着「缺失」——而第四十六条
 * 第二项「用人单位提出、双方协商一致解除」本来就是经济补偿的一条独立路径。后果是三层，
 * 每一层都读得通：N 的两条路径（N-2a / N-2b）双双立不住 ⇒ 风险档位落到「依据不足」⇒
 * 争点表让他去补一份他永远不会有的《解除通知书》，而他手上那份已签协议一个字都没被提到。
 *
 * 【反方向同样贵，所以这一组两臂都钉】协商一致解除**不是**用人单位单方作出的决定：
 * 2N（违法解除赔偿金）不因它成立，司法解释（一）第四十四条那句「因用人单位作出的……决定」
 * 的举证倒置也不该被一份双方谈成的协议触发。跟着一起放开的形态是——一个自愿签了 N+1 的人
 * 被告知"违法解除赔偿金这一项已经立住"，并被指去打一场他签过字的仗。
 */
describe('协商一致解除：N-2a 认它，2N 与规则三不认', () => {
  const factsWith = (over: FactsOver = {}): ElementFactsView => ({
    case: {
      employed_from: '2020-03-01',
      position: '后端工程师',
      monthly_wage_fen: 2_500_000,
      contract_count: '续签过一次',
    },
    claims: [
      { kind: 'N', source_tier: '自述' },
      { kind: '2N', source_tier: '自述' },
    ],
    companies: [{ role: '签约主体', source_tier: '自述' }],
    evidence: [],
    ...over,
    timeline: timelineOf(over),
  });
  const sheetOf = (over: FactsOver = {}) =>
    buildElementSheet(factsWith(over), LABOR.elementCards ?? [], ['N', '2N']);
  const rowOf = (id: string, over: FactsOver = {}) => sheetOf(over).rows.find((r) => r.id === id)!;
  const onFile = (over: FactsOver) => counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsWith(over));
  /** 争点表：与产线同一条链（要件表 → counterpartyDecisionOnFile → buildIssueTable）。 */
  const tableOf = (over: FactsOver) => {
    const sheet = sheetOf(over);
    return buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile(over) }, sheet.rendered);
  };
  /** 一份材料（默认员工手册那一类「公司文件」）+ 一条带类型的「公司动作」。 */
  const negotiated = (tier: string, title = 'HR 递来《协商解除协议》，当天签了'): FactsOver => ({
    evidence: [{ category: '公司文件' }],
    timeline: [{ kind: '公司动作', source_tier: tier, title, event_type: 'company_negotiation' }],
  });

  it('(a) 协商解除那条事件（自述）⇒ N-2a 成立·待证，而 2N 那两张仍「缺失」', () => {
    const over = negotiated('自述');
    expect(rowOf('N-2a', over).status, 'N-2a 没有认下协商一致解除这一档').toBe('成立·待证');
    expect(rowOf('N-2a', over).missingSlots).toEqual([]);
    for (const id of ['2N-2', '2N-3'] as const) {
      const row = rowOf(id, over);
      expect(row.status, `${id} 把一份协商解除协议当成了公司单方作出的决定`).toBe('缺失');
      expect(row.missingSlots, `${id} 的缺口没点名那条单方决定`).toEqual([COMPANY_ACTION_MISSING]);
    }
  });

  it('(a) 已签协议（书证）+ 同类型事件（书证）⇒ N-2a 成立；2N 那两张不动', () => {
    // 【为什么两档都要钉】只钉「成立」，把协商那一格写成恒 true 也是绿的；
    // 只钉「成立·待证」，两个槽取最强档（而不是最弱）同样绿。
    const over = negotiated('书证');
    expect(rowOf('N-2a', over).status).toBe('成立');
    for (const id of ['2N-2', '2N-3'] as const) {
      expect(rowOf(id, over).status, `${id} 跟着协商解除一起抬起来了`).toBe('缺失');
    }
  });

  it('🔴 (a) 规则三不许被协商解除触发：书面决定不在档、争点表里没有 burden_on_other_side', () => {
    // 【它守什么】规则三给的出路是「把他那份书面决定与上面写的理由原样固定下来」——
    // 双方谈成的那份协议不是"用人单位作出的决定"，第四十四条那句倒置管不到它。
    // 变异：把 company_negotiation 误加进 counterpartyDecision ⇒ 这一条红。
    const over = negotiated('书证');
    expect(onFile(over), '一份协商解除协议就让"对方那份书面决定在档"成立了').toBe(false);
    for (const row of tableOf(over).rows) {
      expect(row.reasons, `${row.id} 报了规则三，而档案里没有对方单方作出的那份决定`).not.toContain(
        'burden_on_other_side',
      );
    }
  });

  it('🔴 (a) 风险档位按 N 这条路抬起来：N-2 组的代表行是 N-2a，N-2b 的「缺失」不再拖着它', () => {
    // 【为什么钉的是代表行，而不是直接调 riskBandOf】riskBandOf 要一个库（lib/cases/claims.ts
    // 现取档案），而它抬不抬档**只由这一步决定**：representativeElementIds 取组内最好的那一档，
    // 之后 band 才按 adverse / missing / pending 分档。这一步错了，band 必然错；
    // 这一步对了，band 就是那张表照着 status 读出来的。
    const over = negotiated('自述');
    const represents = representativeElementIds(sheetOf(over).rows);
    expect(represents.has('N-2a'), '走通的那条路没当上代表行').toBe(true);
    expect(represents.has('N-2b'), '没走的那条路还在拖着风险档位（band 会落到「依据不足」）').toBe(false);
    // 【band 那一步只数代表行里的「缺失」】所以这里数的是**解除路径那一组**贡献了几条：
    // 认下协商一致解除之后这一组一条都不贡献（N-3「计算基数」照旧缺，那是另一件事、
    // 该缺就缺——把整项 N 一起断言的形态是这条判据在测工资流水有没有上传）。
    const gapsOfExitGroup = (o?: FactsOver) => {
      const rows = sheetOf(o).rows;
      const rep = representativeElementIds(rows);
      return rows
        .filter((r) => r.alternativeGroup === 'N-解除路径' && rep.has(r.id) && r.status === '缺失')
        .map((r) => r.id);
    };
    expect(gapsOfExitGroup(over), '解除路径这一组还在往风险缺口里报「缺失」').toEqual([]);
    // 反臂：这个人什么都没有时，两条路都是代表行、两条都报缺（这道分组不是"藏起一条"）
    const empty = representativeElementIds(sheetOf().rows);
    expect(empty.has('N-2a') && empty.has('N-2b')).toBe(true);
    expect(gapsOfExitGroup(), '这一票之前那个已签协议的用户读到的就是这两条').toEqual(['N-2a', 'N-2b']);
  });

  it('🔴 (b) 公司单方作出的那个决定（书证）照旧全抬、规则三照旧触发（不回退）', () => {
    // 【为什么这条必须并排放着】上面几条的修法是"N-2a 多认一种类型"。多认过头、
    // 或把类型判定改成"任一命中即过"的形态，在这一条上看不出来——所以它钉的是另一件事：
    // 协商那一档加进来之后，原来那条路一个字都没变。
    const over: FactsOver = {
      evidence: [{ category: '公司文件' }],
      timeline: [
        { kind: '公司动作', source_tier: '书证', title: DECISION_EVENT, event_type: 'company_termination' },
      ],
    };
    for (const id of ['N-2a', '2N-2', '2N-3'] as const) {
      expect(rowOf(id, over).status, `${id} 没有按类型认下来`).toBe('成立');
    }
    expect(onFile(over), '规则三的第二个条件不成立了').toBe(true);
    // 举证责任整条在对方的那两张（N-2a / 2N-3）由规则三留在争点表上
    for (const id of ['N-2a', '2N-3'] as const) {
      expect(tableOf(over).rows.find((r) => r.id === id)!.reasons, `${id} 没被规则三捞进来`).toContain(
        'burden_on_other_side',
      );
    }
  });

  it('🔴 (c) 没选类型的那条记录：「双方协商一致解除，已签协议」照旧不认（正则兜底不跟着放宽）', () => {
    // 【为什么兜底这条路不放宽】从一段自由文本里认"这份协商解除协议签没签字"认不准，
    // 而认错的代价是把一个还在被催签的人判成"这一项已经立住"。只有**显式选过类型**
    // 才走协商那条路（误差方向：宁可多问一句）。
    // 变异：把 COMPANY_DECISION_NEGOTIATED 从谓词里去掉 ⇒ 这一条红。
    for (const raw of ['双方协商一致解除，已签协议', '与公司协商一致解除劳动合同，协议已经签了']) {
      const over: FactsOver = {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '书证', title: raw }],
      };
      for (const id of ['N-2a', '2N-2', '2N-3'] as const) {
        const row = rowOf(id, over);
        expect(row.status, `「${raw}」（没选类型）把 ${id} 抬成了 ${row.status}`).toBe('缺失');
        expect(row.missingSlots, `「${raw}」在 ${id} 上的缺口没点名`).toEqual([actionMissingFor(id)]);
      }
      expect(onFile(over)).toBe(false);
    }
  });
});
