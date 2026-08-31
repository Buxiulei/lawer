// app/src/lib/company/__tests__/patterns.test.ts
// 判据 A4 / A5 / A6（LLM 套路归纳的零编造约束），每条自带变异臂。
//
// 变异臂全部是**同臂对照**：拿同一份夹具，按「被改坏的那种写法」再判一次，
// 断言那种写法会放行。这一步才是判据的牙——没有它，
// 「校验拦住了」与「这条候选本来就进不去」在测试输出里长得一模一样。
import { describe, it, expect } from 'vitest';

import {
  generatePatterns,
  normalizeForQuote,
  parseCandidates,
  verifyCandidates,
  type PatternLlm,
} from '../patterns';
import { getBlock } from '../blocks';

import { mkChain, newDb, seedDoc } from './fixtures';

/** 计次的假模型。**调用次数本身就是一条判据**（A6 断言它是 0）。 */
function fakeLlm(reply: string): PatternLlm & { calls: number } {
  const llm = {
    calls: 0,
    billingModel: 'test-model',
    async chatJSON(): Promise<string> {
      llm.calls += 1;
      return reply;
    },
  };
  return llm;
}

// 一篇真判决摘录，**正文里引用了另一个案号**——这是 A4 变异臂的关键：
// 判决书正文引用别的案号是常态，所以「这个案号在不在 prompt 文本里」根本不是存在性判据。
const DOC_TEXT =
  '本院认为，用人单位主张已足额支付工资，但未提交工资表原件。' +
  '参照（2021）京0105民初99999号案的处理意见，本院对该主张不予采信。' +
  '判决如下：一、被告于本判决生效之日起十日内支付原告违法解除劳动合同赔偿金８６，０００元。';

describe('A6 输入白名单为空：一次模型都不调', () => {
  it('只有仅列表项的行 ⇒ 不调用模型、块标 skipped（不是 ok）', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'L1' }); // 仅列表项
    seedDoc(db, profileId, dossierId, { case_no: 'L2', has_fulltext: 0, summary: '有摘要但没取到全文' });

    const llm = fakeLlm('{"patterns":[]}');
    const r = await generatePatterns(db, dossierId, llm);

    expect(llm.calls).toBe(0); // ← 判据本体：白名单为空就不该花这笔钱
    expect(r.skipped).toBe(true);
    expect(r.fedDocs).toBe(0);

    const block = getBlock(db, dossierId, 'patterns')!;
    expect(block.status).toBe('skipped'); // 与 ok 分开：这块其实是空的，不能藏进绿灯里
    expect(block.finished_at).not.toBeNull();
    expect(block.note).toContain('未调用模型');
    db.close();
  });

  // 变异臂：只要有一篇全文，模型就必须被调用一次——
  // 否则「calls=0」可能只是因为这条路径根本跑不起来。
  it('变异臂：有全文可喂时 calls 必须为 1', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'F1', has_fulltext: 1, summary: DOC_TEXT });

    const llm = fakeLlm('{"patterns":[]}');
    const r = await generatePatterns(db, dossierId, llm);
    expect(llm.calls).toBe(1);
    expect(r.skipped).toBe(false);
    expect(getBlock(db, dossierId, 'patterns')!.status).toBe('ok');
    db.close();
  });
});

describe('A4 案号不在库：整条丢弃并计数', () => {
  /** 两份档案：目标档案有 F1；另一份档案有 X9。模型引用 X9 与正文里被引用的那个案号。 */
  function setup() {
    const db = newDb();
    const mine = mkChain(db, '甲公司有限公司');
    const other = mkChain(db, '乙公司有限公司');
    seedDoc(db, mine.profileId, mine.dossierId, { case_no: 'F1', has_fulltext: 1, summary: DOC_TEXT });
    seedDoc(db, other.profileId, other.dossierId, { case_no: 'X9', has_fulltext: 1, summary: '另一家公司的判决原文。' });
    return { db, dossierId: mine.dossierId };
  }

  it('evidence 的案号不在本档案 ⇒ 该 pattern 被丢、dropped_patterns=1', async () => {
    const { db, dossierId } = setup();
    const llm = fakeLlm(
      JSON.stringify({
        patterns: [
          {
            pattern: '惯用「已足额支付」抗辩但不举证',
            evidence: [{ case_no: 'X9', quote: '本院认为，用人单位主张已足额支付工资' }],
          },
        ],
      }),
    );
    const r = await generatePatterns(db, dossierId, llm);

    expect(r.kept).toBe(0);
    expect(r.dropped).toBe(1);
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_patterns WHERE dossier_id = ?')
      .get(dossierId) as { n: number };
    expect(n).toBe(0);
    const snap = db
      .prepare('SELECT dropped_patterns FROM company_dossier_stats WHERE dossier_id = ?')
      .get(dossierId) as { dropped_patterns: number };
    expect(snap.dropped_patterns).toBe(1); // 编造率的体温计必须留下读数
    db.close();
  });

  // 变异臂：把存在性判据换成「这个案号在不在 prompt 文本里」（一种看起来很合理的写法）。
  // 判决正文里引用了（2021）京0105民初99999号，于是那种写法会把它当成真证据放行——
  // 这正是本判据要拦的形态。断言：真实现丢、松写法留。
  it('变异臂：改成「查 prompt 上下文」的写法会放行正文里被引用的案号', async () => {
    const { db, dossierId } = setup();
    const citedCaseNo = '（2021）京0105民初99999号';
    const candidates = parseCandidates(
      JSON.stringify({
        patterns: [
          {
            pattern: '援引旧案压低赔偿',
            evidence: [{ case_no: citedCaseNo, quote: '本院对该主张不予采信' }],
          },
        ],
      }),
    );
    const docs = [{ case_no: 'F1', summary: DOC_TEXT }];

    // 真实现：SQL 存在性查询 ⇒ 丢
    const real = verifyCandidates(db, dossierId, candidates, docs);
    expect(real.kept.length).toBe(0);
    expect(real.dropped).toBe(1);

    // 松写法：只看案号有没有出现在喂进去的正文里 ⇒ 放行（所以这条夹具确实能分辨两者）
    const promptText = docs.map((d) => d.summary).join('\n');
    const looseKept = candidates.filter((c) =>
      c.evidence.some((e) => promptText.includes(e.case_no)),
    );
    expect(looseKept.length).toBe(1);
    db.close();
  });
});

describe('A5 引文必须逐字：同义改写一律丢', () => {
  function setup() {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'F1', has_fulltext: 1, summary: DOC_TEXT });
    return { db, dossierId };
  }

  it('quote 是同义改写（关键词都在、字不一样）⇒ 丢', async () => {
    const { db, dossierId } = setup();
    const llm = fakeLlm(
      JSON.stringify({
        patterns: [
          {
            pattern: '主张已付但不举证',
            // 原文是「用人单位主张已足额支付工资，但未提交工资表原件」
            evidence: [{ case_no: 'F1', quote: '公司称工资已经全额发放，却没有提供工资表的原件' }],
          },
        ],
      }),
    );
    const r = await generatePatterns(db, dossierId, llm);
    expect(r.kept).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.droppedEvidence).toBe(1);
    db.close();
  });

  it('逐字引用（含全角数字/空白差异）⇒ 留', async () => {
    const { db, dossierId } = setup();
    const llm = fakeLlm(
      JSON.stringify({
        patterns: [
          {
            pattern: '主张已付但不举证',
            evidence: [
              // 与原文只差空白与全半角：归一化只做这两件事，所以必须放行
              { case_no: 'F1', quote: '支付原告违法解除劳动合同赔偿金 86,000 元' },
            ],
          },
        ],
      }),
    );
    const r = await generatePatterns(db, dossierId, llm);
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(0);
    const row = db
      .prepare('SELECT pattern, evidence_json, model FROM company_patterns WHERE dossier_id = ?')
      .get(dossierId) as { pattern: string; evidence_json: string; model: string };
    expect(row.pattern).toBe('主张已付但不举证');
    expect(JSON.parse(row.evidence_json)).toHaveLength(1);
    expect(row.model).toBe('test-model');
    db.close();
  });

  // 变异臂：把逐字子串换成「包含关键词」——那种写法会放行上面那条改写。
  // 换一种说法正是编造的形态，所以这条必须分辨得出来。
  it('变异臂：放宽成「包含关键词」会放行同义改写', () => {
    const { db, dossierId } = setup();
    const rewritten = '公司称工资已经全额发放，却没有提供工资表的原件';
    const docs = [{ case_no: 'F1', summary: DOC_TEXT }];
    const candidates = [{ pattern: 'p', evidence: [{ case_no: 'F1', quote: rewritten }] }];

    // 真实现：逐字子串 ⇒ 丢
    expect(verifyCandidates(db, dossierId, candidates, docs).kept.length).toBe(0);

    // 松写法：关键词命中即算 ⇒ 放行
    const hay = normalizeForQuote(DOC_TEXT);
    const keywords = ['工资', '工资表', '原件'];
    expect(keywords.every((k) => hay.includes(k) && rewritten.includes(k))).toBe(true);
    db.close();
  });
});

describe('归纳输出解析：坏输出不许被「修补」成候选', () => {
  it('非 JSON / 缺 patterns / 缺 evidence 一律得到零条或空证据', () => {
    expect(parseCandidates('不是 JSON')).toEqual([]);
    expect(parseCandidates('{"foo":1}')).toEqual([]);
    expect(parseCandidates('{"patterns":[{"pattern":"  "}]}')).toEqual([]);
    expect(parseCandidates('{"patterns":[{"pattern":"p"}]}')).toEqual([{ pattern: 'p', evidence: [] }]);
  });

  it('evidence 为空数组的 pattern 一律丢，不落库', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'F1', has_fulltext: 1, summary: DOC_TEXT });
    const llm = fakeLlm(JSON.stringify({ patterns: [{ pattern: '没有证据的断言', evidence: [] }] }));
    const r = await generatePatterns(db, dossierId, llm);
    expect(r.kept).toBe(0);
    expect(r.dropped).toBe(1);
    db.close();
  });
});
