// citation_check 的判据（设计稿 §2 C 第三条）。
//
// 这条能力不碰数据库，run 的 db / identity 原样忽略——直接调 run，不搭 sqlite。
//
// 【判据夹具从 index.json 现读，不抄第二份清单】写死一份「库里有哪几条」的清单，
// 在有人改卡的那天会变成**空跑**：断言照常绿，验的却是一条已经不存在的东西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { DEFAULT_DOMAIN } from '@/lib/domains/registry';
import { __resetForTest } from '@/lib/knowledge';
import { loadPending, pendingFor } from '@/lib/knowledge/__tests__/grounding-pending';

import { citationCheck } from '../families/knowledge';

const DB = null as unknown as Database;
const ID: Identity = { uid: 1, via: 'api_key', scopes: ['case:read'], keyId: 1 };

interface CitationOut {
  law: string | null;
  article: string | null;
  key?: string;
  found: boolean;
  exact_text: string | null;
  card_id: string | null;
  card_title?: string;
  note: string;
}
interface Step {
  step: number;
  name: string;
  status: 'pass' | 'fail' | 'manual';
  detail: string;
}
interface PrecedentOut {
  id: string;
  found: boolean;
  court?: string | null;
  case_no?: string | null;
  holding?: string | null;
  checklist?: Step[];
  method_card?: string;
  note?: string;
}
interface Out {
  citations: CitationOut[];
  precedents: PrecedentOut[];
  note: string;
}
interface Failure {
  ok: false;
  errorCode: string;
  message: string;
}

const check = (args: Record<string, unknown>) => citationCheck.run(DB, ID, args) as Out;

// ───────────────────────── 库存实测夹具 ─────────────────────────

interface IndexEntry {
  id: string;
  type: string;
  title: string;
  confidence: string;
  /** 领域键；只有声明了的卡才有，其余按缺省域算（lib/knowledge 的 packDomain 同口径） */
  domain?: string;
  /** 相对 knowledge/ 的卡片路径——判"这张卡在不在豁免目录下"要用它 */
  path: string;
  facts?: {
    statute_quotes?: Array<{ law: string; article: string; text: string }>;
    case_facts?: { case_no?: string; court?: string; holding?: string; reasoning?: string };
  };
}
const KNOWLEDGE_DIR =
  process.env.LAWER_KNOWLEDGE_DIR ?? path.resolve(process.cwd(), '..', 'knowledge');
const INDEX: IndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(KNOWLEDGE_DIR, 'index.json'), 'utf-8'),
);

/** 归一化判据钉的那一条：卡里以**法名全称 + 汉字条号**存着 */
const LAW_FULL = '中华人民共和国劳动合同法';
const LAW_SHORT = '劳动合同法';
const ARTICLE_CN = '第四十六条';
/** 同名前缀的另一部法（短名吞长名的反例来源） */
const LAW_SIBLING = '中华人民共和国劳动合同法实施条例';

/**
 * 库里这一条的逐字原文。**取最长的那一份**，与产线的 `findQuote` 同规则。
 *
 * 【为什么不是 `.find()`】条号归一会剥掉「第N项/第N款」，于是"只录了某一项的 SOP 卡"
 * 与"录了整条的法条卡"落在同一个键上。判据用第一个、产线用另一个规则时，
 * 这条判据会以「期望（六）…、实际（五）…」的形式红，而两边其实都没错——
 * 错的是两把尺不共用刻度。
 */
const quoteOf = (law: string, article: string) =>
  INDEX.flatMap((e) => e.facts?.statute_quotes ?? [])
    .filter((q) => q.law === law && q.article === article)
    .sort((a, b) => b.text.length - a.text.length)[0];

describe('判据夹具有效性（夹具失效会让下面几条变成空跑）', () => {
  it('库里确实以法名全称 + 汉字条号收录着这一条的逐字原文', () => {
    const q = quoteOf(LAW_FULL, ARTICLE_CN);
    expect(q, `index.json 里没有 ${LAW_FULL}${ARTICLE_CN} 的 statute_quotes`).toBeTruthy();
    expect(q!.text.length).toBeGreaterThan(20);
    // 三种写法互不相同，归一化才有活干；若卡里本来就存的是简称，这条判据等于没验
    expect(LAW_FULL).not.toBe(LAW_SHORT);
  });

  it('库里另有一部以它为前缀的法（短名吞长名的反例是真的存在的）', () => {
    expect(INDEX.some((e) => (e.facts?.statute_quotes ?? []).some((q) => q.law === LAW_SIBLING))).toBe(
      true,
    );
    expect(LAW_SIBLING.startsWith(LAW_FULL)).toBe(true);
  });
});

// ───────────────────────── 法条核验 ─────────────────────────

describe('citation_check · 法条', () => {
  it('三种法名写法命中同一条：《法名》/ 简称 / 全称（变异：去掉 normLaw 归一 → 后两种 found:false，红）', () => {
    const out = check({
      citations: [
        { law: `《${LAW_SHORT}》`, article: ARTICLE_CN },
        { law: LAW_SHORT, article: ARTICLE_CN },
        { law: LAW_FULL, article: ARTICLE_CN },
      ],
    });
    expect(out.citations).toHaveLength(3);
    for (const c of out.citations) {
      expect(c.found, `${c.law} 没命中`).toBe(true);
      expect(c.exact_text).toBe(quoteOf(LAW_FULL, ARTICLE_CN)!.text);
      expect(c.card_id).toBeTruthy();
    }
    // 三条落在同一张卡、同一段原文上（键归一到同一个）
    expect(new Set(out.citations.map((c) => c.card_id)).size).toBe(1);
    expect(new Set(out.citations.map((c) => c.key)).size).toBe(1);
  });

  it('阿拉伯数字条号与「第N项」也归一到同一条（模型惯写「第46条第2项」）', () => {
    const out = check({ citations: [{ law: LAW_SHORT, article: '第46条第2项' }] });
    expect(out.citations[0].found).toBe(true);
    expect(out.citations[0].exact_text).toBe(quoteOf(LAW_FULL, ARTICLE_CN)!.text);
  });

  it('条号不存在 ⇒ found:false + 「不要引用」，exact_text 为 null（变异：找不到时仍回 found:true → 红）', () => {
    const out = check({ citations: [{ law: LAW_SHORT, article: '第九百九十九条' }] });
    const c = out.citations[0];
    expect(c.found).toBe(false);
    expect(c.exact_text).toBeNull();
    expect(c.card_id).toBeNull();
    expect(c.note).toContain('不要引用');
  });

  it('法名不存在 ⇒ found:false（不会因为条号对上就把别的法的原文塞回来）', () => {
    const out = check({ citations: [{ law: '我编的一部法', article: ARTICLE_CN }] });
    expect(out.citations[0].found).toBe(false);
    expect(out.citations[0].note).toContain('不要引用');
  });

  it('短名不吞长名：拿短法名去要长法名独有的条号 ⇒ found:false（张冠李戴比对不上键危险）', () => {
    // 【条号从库里现挑，不写死】原来这里写死的是「第二十五条」——那时它只有实施条例有；
    // 2026-09-07 有张卡给母法也录了第二十五条，这条判据就以"夹具失效"的形式红了。
    // 判据要的从来不是那个具体条号，而是"存在一个只属于长法名的条号"。
    const fullArticles = new Set(
      INDEX.flatMap((e) => e.facts?.statute_quotes ?? [])
        .filter((q) => q.law === LAW_FULL)
        .map((q) => q.article),
    );
    const onlySibling = INDEX.flatMap((e) => e.facts?.statute_quotes ?? []).find(
      (q) => q.law === LAW_SIBLING && !fullArticles.has(q.article),
    );
    expect(onlySibling, '夹具失效：库里没有"只有实施条例有、母法没有"的条号了').toBeTruthy();
    const article = onlySibling!.article;

    const out = check({ citations: [{ law: LAW_SHORT, article }] });
    expect(out.citations[0].found, `${LAW_SHORT}${article} 不该命中`).toBe(false);
    // 反向：写全实施条例的名字就能命中
    const ok = check({ citations: [{ law: '劳动合同法实施条例', article }] });
    expect(ok.citations[0].found).toBe(true);
    expect(ok.citations[0].exact_text).toBe(quoteOf(LAW_SIBLING, article)!.text);
  });

  it('law 或 article 缺一 ⇒ 该条按未核验处理，不要引用（不静默当成命中）', () => {
    const out = check({ citations: [{ article: ARTICLE_CN }, { law: LAW_SHORT }] });
    expect(out.citations.map((c) => c.found)).toEqual([false, false]);
    for (const c of out.citations) expect(c.note).toContain('不要引用');
  });
});

// ───────────────────────── 判例核验四步法 ─────────────────────────

/** 四步法能全过第一步的样本：原文核实 + 卡内录有裁判理由 */
const VERBATIM_CASE = INDEX.find(
  (e) =>
    e.type === '判例卡' &&
    e.confidence === '原文核实' &&
    e.facts?.case_facts?.reasoning &&
    e.facts.case_facts.court &&
    e.facts.case_facts.case_no,
);
/**
 * 二手转述样本：按方法卡第一步只能标「仅内部参考」。
 *
 * 【为什么这一张是造出来的，而不是从库里找的】主理人 2026-09-07 裁决**禁止**知识库里
 * 存在「二手转述」「待核实」的卡（追不到一手源的整张移进 knowledge/quarantine/），
 * 于是"库里找一张二手转述的判例卡"从 2026-09-07 起恒为 undefined——原来那条
 * `INDEX.find(...)` 会让整组判据带着 `HEARSAY_CASE!` 直接 TypeError，
 * 而它测的那段代码（confidence≠原文核实 ⇒ 第一步不过）一行没变、仍在产线上跑。
 *
 * 【怎么造】复制一份知识库到临时目录，只把 index.json 里某张判例卡的 confidence 改成
 * 「二手转述」（卡文件不动——加载器只比对 id，不比对 confidence），
 * 再用 LAWER_KNOWLEDGE_DIR 指过去。这与 index-guard.test.ts 造坏索引是同一套手法。
 */
let hearsayDir: string | null = null;
let HEARSAY_ID = '';

describe('citation_check · 判例四步法', () => {
  beforeAll(() => {
    const donor = INDEX.find((e) => e.type === '判例卡' && e.id !== VERBATIM_CASE?.id);
    HEARSAY_ID = donor!.id;
    hearsayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-kb-hearsay-'));
    for (const name of ['index.json', 'aliases.json', 'packs']) {
      const src = path.join(KNOWLEDGE_DIR, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(hearsayDir, name), { recursive: true });
    }
    const idxPath = path.join(hearsayDir, 'index.json');
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')) as { id: string; confidence: string }[];
    idx.find((e) => e.id === HEARSAY_ID)!.confidence = '二手转述';
    fs.writeFileSync(idxPath, JSON.stringify(idx));
    process.env.LAWER_KNOWLEDGE_DIR = hearsayDir;
    __resetForTest();
  });

  afterAll(() => {
    delete process.env.LAWER_KNOWLEDGE_DIR;
    __resetForTest();
    if (hearsayDir) fs.rmSync(hearsayDir, { recursive: true, force: true });
    hearsayDir = null;
  });

  it('夹具有效：有「原文核实带裁判理由」的真卡，也造出了一张「二手转述」的判例卡', () => {
    expect(VERBATIM_CASE, '没有原文核实且带 court/case_no/reasoning 的判例卡').toBeTruthy();
    expect(HEARSAY_ID, '没能从库里挑一张判例卡来改造').toBeTruthy();
    // 【自证夹具真的被改坏了】不验这一条的话，下面那组"第一步不过"可能是**任何**原因不过
    const mutated = JSON.parse(fs.readFileSync(path.join(hearsayDir!, 'index.json'), 'utf8')) as {
      id: string;
      confidence: string;
    }[];
    expect(mutated.find((e) => e.id === HEARSAY_ID)!.confidence).toBe('二手转述');
    // 而真实库里挑不出一张现成的——这正是这张卡必须造出来的原因。
    // 【为什么按豁免目录分开数】带 GROUNDING_PENDING 的包整包欠着账（有到期日），
    // 它的卡照常进索引、confidence 照常是最低档；把它们并进来数，这条会红成"回归"。
    // 分两句说：`二手转述` 全库一张不许有；`待核实` 只许出现在豁免目录里。
    const pending = loadPending(KNOWLEDGE_DIR);
    expect(INDEX.filter((e) => e.confidence === '二手转述').map((e) => e.id)).toEqual([]);
    expect(
      INDEX.filter((e) => e.confidence === '待核实' && pendingFor(e.path, pending) === null).map(
        (e) => e.id,
      ),
      '豁免目录之外冒出了「待核实」的卡',
    ).toEqual([]);
  });

  it('回 court / case_no / holding 摘要 + 四步各一条（变异：漏掉任一步 → 红）', () => {
    const out = check({ precedent_ids: [VERBATIM_CASE!.id] });
    const p = out.precedents[0];
    expect(p.found).toBe(true);
    expect(p.court).toBe(VERBATIM_CASE!.facts!.case_facts!.court);
    expect(p.case_no).toBe(VERBATIM_CASE!.facts!.case_facts!.case_no);
    expect(p.holding).toBeTruthy();
    expect(p.method_card).toBe('method-panli-heyan-sibufa');

    expect(p.checklist).toHaveLength(4);
    expect(p.checklist!.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    for (const s of p.checklist!) {
      expect(s.name, `第 ${s.step} 步没有名字`).toBeTruthy();
      expect(s.detail.length, `第 ${s.step} 步的 detail 是空话`).toBeGreaterThan(10);
      expect(['pass', 'fail', 'manual']).toContain(s.status);
    }
    // 原文核实 + 有裁判理由 ⇒ 第一步过
    expect(p.checklist![0].status).toBe('pass');
    // 没给 assert_terms ⇒ 第三步如实标 manual 并说清要补什么，而不是假装过了
    expect(p.checklist![2].status).toBe('manual');
    expect(p.checklist![2].detail).toContain('assert_terms');
  });

  it('二手转述的卡：第一步不过 ⇒ 第四步结论「不可用」（变异：第一步无条件 pass → 红）', () => {
    const out = check({ precedent_ids: [HEARSAY_ID] });
    const steps = out.precedents[0].checklist!;
    expect(steps[0].status).toBe('fail');
    expect(steps[0].detail).toContain('内部参考');
    expect(steps[3].status).toBe('fail');
    expect(steps[3].detail).toContain('不可用');
  });

  it('给了 assert_terms：零出现的词让第三步 fail、第四步判「不可用」；命中的词 pass', () => {
    const miss = check({
      precedent_ids: [VERBATIM_CASE!.id],
      assert_terms: ['这个词在任何一张卡里都不会出现的怪词'],
    });
    const missSteps = miss.precedents[0].checklist!;
    expect(missSteps[2].status).toBe('fail');
    expect(missSteps[2].detail).toContain('零出现');
    expect(missSteps[3].status).toBe('fail');
    expect(missSteps[3].detail).toContain('不可用');

    // 用这张卡自己 holding 里的一段词去搜，必然命中
    const own = VERBATIM_CASE!.facts!.case_facts!.holding!.replace(/[*\s]/g, '').slice(0, 4);
    const hit = check({ precedent_ids: [VERBATIM_CASE!.id], assert_terms: [own] });
    expect(hit.precedents[0].checklist![2].status).toBe('pass');
  });

  it('卡 id 不存在 ⇒ found:false + 不要引用（变异：找不到时仍回 found:true → 红）', () => {
    const out = check({ precedent_ids: ['case-我自己编的一个案号'] });
    expect(out.precedents[0].found).toBe(false);
    expect(out.precedents[0].note).toContain('不要引用');
    expect(out.precedents[0].checklist).toBeUndefined();
  });

  it('传的不是判例卡 ⇒ found:false 并说清它是哪一类，不硬套四步法', () => {
    // 【夹具必须限定缺省域】citation_check 走的是 knowledge searcher 的 get，
    // 而 get 只交缺省域的卡（跨域召回默认关闭，设计稿 §13）。
    // 不限定域的形态是：库里排在最前面的那张法条卡属于别的领域，于是这条判据测到的是
    //「取不到这张卡」，而不是它要问的「取到了但类型不对，别硬套四步法」——
    // 判据照样红/绿，红的原因却换了一个。同一处坑另见 knowledge-family.test.ts 的十类样本。
    const statute = INDEX.find(
      (e) => e.type === '法条卡' && (e.domain ?? DEFAULT_DOMAIN) === DEFAULT_DOMAIN,
    )!;
    const out = check({ precedent_ids: [statute.id] });
    expect(out.precedents[0].found).toBe(false);
    expect(out.precedents[0].note).toContain('法条卡');
  });
});

describe('citation_check · 入参', () => {
  it('两个数组都不给 ⇒ isError（回空结果会被读成「全都没问题」）', () => {
    const out = citationCheck.run(DB, ID, {}) as unknown as Failure;
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('NOTHING_TO_CHECK');
  });

  it('一次核太多 ⇒ isError 让它分批，而不是回一坨吃掉对方上下文', () => {
    const many = Array.from({ length: 21 }, () => ({ law: LAW_SHORT, article: ARTICLE_CN }));
    const out = citationCheck.run(DB, ID, { citations: many }) as unknown as Failure;
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('TOO_MANY');
  });

  it('顶层 note 就是「查不到不要编」这条纪律本身', () => {
    const out = check({ citations: [{ law: LAW_SHORT, article: ARTICLE_CN }] });
    expect(out.note).toContain('不要引用');
    expect(out.note).toContain('method-panli-heyan-sibufa');
  });
});
