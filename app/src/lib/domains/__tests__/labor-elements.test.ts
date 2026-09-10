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
import { BURDENS, buildElementSheet, type Burden, type ElementFactsView } from '@/lib/cases/elements';
import { buildIssueTable } from '@/lib/cases/issue-table';

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
  (over.timeline ?? []).map((e) => ({ title: '', detail: null, ...e }));

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
  const N2B_MISSING = '被迫解除通知（请把发出通知这件事记成一条时间线事件）';
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
    ]) {
      const row = withMyAction(raw);
      expect(row.status, `「${raw}」（是公司解除的）被判成了 ${row.status}`).toBe('缺失');
      expect(row.missingSlots, `「${raw}」的缺口没点名`).toEqual([N2B_MISSING]);
      // 它是〔未记录〕不是〔不成立〕：公司解除了不等于"你没发过通知"这件事被证伪
      expect(row.status).not.toBe('不成立');
    }
  });

  it('两件事真的都发生时不误伤：公司放话要裁，我先发出了被迫解除通知书', () => {
    // 【为什么要有这条】前置排除若写成"提到公司解除就一律不认"，这个人——本行当里
    // 「先下手」那一类——会读到「还差那份通知」，而他手上正拿着 EMS 回执。
    expect(withMyAction('公司放话要裁我，我当天就发出了被迫解除通知书').status).toBe('成立·待证');
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
    timeline: [{ kind: '公司动作', source_tier: '书证' }],
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
    expect(a.missingSlots, '缺口没点到"公司确实作出过这个决定"那条记录').toContain('timeline:公司动作');
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
        timeline: [{ kind: '公司动作', source_tier: '自述' }],
      }).status,
      '事件只有当事人自己说，这一条就到不了「成立」',
    ).toBe('成立·待证');
  });

  it('只有那条「公司动作」、公司那份文件不在档 ⇒ 仍是「缺失」，且缺口点名那份文件', () => {
    // satisfiedBy 是「与」不是「或」：新加一个槽不许把原来那个槽变成可选。
    const row = rowOf('N-2a', { timeline: [{ kind: '公司动作', source_tier: '书证' }] });
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
    const cardSlots = (id: string) => [...((LABOR.elementCards ?? []).find((c) => c.id === id)?.satisfiedBy ?? [])];
    const pack = [...(LABOR.counterpartyDecisionSlot ?? [])];
    expect(pack, 'counterpartyDecisionSlot 没声明').not.toEqual([]);
    // 【为什么钉的是取值而不是"都引用了那个常量"】常量是不是被引用，判据看不见——
    // 能看见的只有取值。四处取值相等，就把"再内联一份字面量"与"改了一处忘了另外三处"
    // 一起挡在门外：那两种做法都会让下面这三行里的某一行对不上。
    expect(cardSlots('2N-2'), '2N-2 与本包的 counterpartyDecisionSlot 对不上').toEqual(pack);
    expect(cardSlots('2N-3'), '2N-3 与本包的 counterpartyDecisionSlot 对不上').toEqual(pack);
    expect(cardSlots('N-2a'), 'N-2a 与本包的 counterpartyDecisionSlot 对不上').toEqual(pack);
  });

  it('只有一份「公司文件」**不能**把 2N-2 抬成「成立」（变异：2N-2 改回单槽 → 红）', () => {
    // 风闻裁员、还没收到任何解除通知、先把员工手册传上来的那个人：
    // 「公司单方解除或终止了劳动合同」当场写着「成立」，而他手上一份解除通知都没有。
    const only = { evidence: [{ category: '公司文件' }] };
    const row = rowOf('2N-2', only);
    expect(row.status, `只有一份公司文件时 2N-2 被判成了 ${row.status}`).toBe('缺失');
    expect(row.missingSlots, '缺口没点到"公司确实作出过这个决定"那条记录').toContain('timeline:公司动作');
  });

  it('公司文件 + 那条「公司动作」 ⇒ 2N-2 成立；事件只有自述时天花板是「成立·待证」', () => {
    // 【为什么两档都要钉】只钉「成立」那一格，把新槽写成恒 true 也是绿的；
    // 只钉「成立·待证」，两个槽取最强档（而不是最弱）同样绿。
    expect(
      rowOf('2N-2', {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '书证' }],
      }).status,
    ).toBe('成立');
    expect(
      rowOf('2N-2', {
        evidence: [{ category: '公司文件' }],
        timeline: [{ kind: '公司动作', source_tier: '自述' }],
      }).status,
      '事件只有当事人自己说，这一条就到不了「成立」',
    ).toBe('成立·待证');
  });

  it('只有那条「公司动作」、公司那份文件不在档 ⇒ 2N-2 仍是「缺失」，且缺口点名那份文件', () => {
    // satisfiedBy 是「与」不是「或」：新加一个槽不许把原来那个槽变成可选。
    const row = rowOf('2N-2', { timeline: [{ kind: '公司动作', source_tier: '书证' }] });
    expect(row.status).toBe('缺失');
    expect(row.missingSlots).toContain('evidence:公司文件');
  });
});
