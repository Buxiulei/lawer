// app/src/lib/docs/__tests__/doc-review.test.ts
// 来文解读端到端（假模型 + 假 sidecar）。要害七条：
//   ① 报价这一步一分钱都不动，**也不调模型**（变异臂：跳过报价直接扣费 → 红）
//   ② 确认之后三张空表从零到有：company_docs / contract_reviews / review_findings
//   ③ 规则库真的被比对：must 规则命中落进 findings，且 severity 取**规则库的常量**
//      （变异臂：不喂规则 / 不认 rule_id → 红，因为假模型在这条上谎报 suggest）
//   ④ 逐条校验：编出来的 rule_id、原文里找不到的引文，一条都不许落库
//   ⑤ 没有提取文本的材料会先过一次 OCR（假 sidecar），结果同时回填到证据上
//   ⑥ 同一张报价重放不二扣、不二写、不再调模型
//   ⑦ 别人的解读一律「不存在」
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-review-'));
process.env.FILES_DIR = FILES_DIR;

import { getGongdao, gongdaoGrant } from '../../billing';
import { quoteService } from '../../billing/service-quotes';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';
import { PRICE_FALLBACK } from '../../billing/pricing-config';
import { runMigrations } from '../../db/migrate';
import { storeBytes } from '../../evidence/files';
import { getDoc, listDocs } from '../read';
import { rulesFor } from '../rules';
import { submitDoc, type DocQuoteResult, type DocReviewResult } from '../review';

const PER_DOC = PRICE_FALLBACK['doc_review.per_doc'];

/** 被解读的那份文件。两处引文是后面判据要逐字对上的靶子。 */
const NOTICE =
  '解除劳动合同协议书\n' +
  '甲乙双方经协商，因本人个人原因申请离职，自 2026-09-30 起解除劳动合同。\n' +
  '乙方确认与甲方之间再无其他任何争议及权利义务关系。\n';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '本人案件').lastInsertRowid,
  );
  gongdaoGrant(uid, 500, GONGDAO_LEDGER_TYPE.recharge, `top-${uid}`, null, db);
  return { db, uid, other, caseId };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * 假模型。默认那份回包里**故意埋了三条**：
 *   · xsjc-001：真规则、真引文，但 severity 谎报 suggest（真值 must）——用来钉住「severity 取规则库」
 *   · 编出来的规则号 xsjc-999
 *   · 原文里根本没有的引文
 */
function fakeLlm(payload?: unknown) {
  const calls: string[] = [];
  return {
    calls,
    billingModel: 'fake-json-model',
    chatJSON: async (messages: { role: string; content: string }[]) => {
      calls.push(messages[messages.length - 1].content);
      return JSON.stringify(
        payload ?? {
          summary: '这份协议把解除定性成个人原因，并塞了一条概括弃权。',
          advice: '改签',
          advice_detail: '把解除原因改成协商一致由公司提出，并删掉弃权条款后再签。',
          findings: [
            {
              rule_id: 'xsjc-001',
              clause_ref: '因本人个人原因申请离职',
              issue: '解除原因被写成个人原因',
              severity: 'suggest',
            },
            { rule_id: 'xsjc-999', clause_ref: '乙方确认', issue: '编出来的规则号' },
            { clause_ref: '本协议经双方盖章后生效', issue: '原文里没有这句话' },
          ],
        },
      );
    },
  };
}

function mustOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实得失败：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

afterAll(() => {
  fs.rmSync(FILES_DIR, { recursive: true, force: true });
});

describe('① 报价这一步不动钱也不调模型', () => {
  test('回一张报价；余额、账本行数、三张表全部逐字不变', async () => {
    const { db, uid, caseId } = makeDb();
    const llm = fakeLlm();
    const before = { balance: getGongdao(uid, db), ledger: count(db, 'gongdao_ledger') };

    const r = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };

    expect(r.stage).toBe('quote');
    expect(r.quote.amount).toBe(PER_DOC);
    expect(getGongdao(uid, db)).toBe(before.balance);
    expect(count(db, 'gongdao_ledger')).toBe(before.ledger);
    expect(count(db, 'company_docs')).toBe(0);
    // 报价阶段调模型 = 用户还没点头就已经花了算力，且下一步确认时还会再花一次
    expect(llm.calls.length).toBe(0);
    // 报价本身要落一行，否则确认时那个价是从哪来的没人说得清
    expect(count(db, 'service_quotes')).toBe(1);
  });

  test('别人的案件报不出价（不区分「不存在」与「不是你的」）', async () => {
    const { db, other, caseId } = makeDb();
    const r = await submitDoc(
      db,
      { userId: other, caseId, text: NOTICE, docKind: '解除通知' },
      { llm: fakeLlm() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('CASE_NOT_FOUND');
  });
});

describe('② / ③ / ④ 确认之后：三张表从零到有，规则库说了算', () => {
  test('落库、扣费、逐条校验一次跑通', async () => {
    const { db, uid, caseId } = makeDb();
    const llm = fakeLlm();
    expect(count(db, 'company_docs')).toBe(0);
    expect(count(db, 'contract_reviews')).toBe(0);
    expect(count(db, 'review_findings')).toBe(0);

    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };
    const balanceAfterQuote = getGongdao(uid, db);

    const done = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };

    // ② 三张表从零到有
    expect(done.stage).toBe('done');
    expect(count(db, 'company_docs')).toBe(1);
    expect(count(db, 'contract_reviews')).toBe(1);
    expect(count(db, 'review_findings')).toBe(1);
    expect(done.charged).toBe(PER_DOC);
    expect(getGongdao(uid, db)).toBe(balanceAfterQuote - PER_DOC);
    expect(llm.calls.length).toBe(1);

    // ③ 命中的是**规则库里真有的那条 must**，且 severity 取规则库而不是模型说的 suggest
    const finding = done.doc.findings[0];
    expect(finding.rule_id).toBe('xsjc-001');
    expect(finding.severity).toBe('must');
    const rule = rulesFor('解除通知').find((r) => r.id === 'xsjc-001')!;
    expect(finding.basis).toBe(rule.basis);
    expect(finding.suggestion).toBe(rule.suggestion);
    // 规则确实被喂进模型了（不喂而恰好命中是不可能的）
    expect(done.rules_considered).toBeGreaterThan(20);
    expect(llm.calls[0]).toContain('xsjc-001');

    // ④ 编出来的规则号与找不到的引文各丢一条，且如实计数
    expect(done.dropped_findings).toBe(2);
    expect(done.doc.findings.map((f) => f.rule_id)).not.toContain('xsjc-999');
    // 粘进来的原文首尾空白会被去掉（str()），正文一字不改
    expect(done.doc.ocr_text).toBe(NOTICE.trim());
    expect(done.doc.advice).toBe('改签');
    expect(done.doc.doc_type).toBe('解除通知');
    expect(done.doc.model).toBe('fake-json-model');

    // 页面高亮用的 risk_flags：引文必须能在原文里 indexOf 得到，否则一处也标不出来
    expect(done.doc.risk_flags).toHaveLength(1);
    expect(done.doc.risk_flags[0].level).toBe('高');
    expect(NOTICE.includes(done.doc.risk_flags[0].quote)).toBe(true);
  });

  test('模型给不出四态里的结论时落「待定」，不猜一个', async () => {
    const { db, uid, caseId } = makeDb();
    const llm = fakeLlm({ summary: '看不清', advice: '也许可以签吧', findings: [] });
    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '其他' }, { llm }),
    ) as DocQuoteResult & { ok: true };
    const done = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, text: NOTICE, docKind: '其他', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };
    expect(done.doc.advice).toBe('待定');
  });
});

describe('⑤ 没有提取文本的材料先过一次 OCR（假 sidecar）', () => {
  let server: http.Server;
  let prevUrl: string | undefined;
  const OCR_TEXT = '解除劳动合同协议书\n因本人个人原因申请离职，自 2026-09-30 起解除。';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url !== '/ocr' || req.method !== 'POST') {
          res.writeHead(404).end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: OCR_TEXT, model: 'fake-vl', request_id: 'req-1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    prevUrl = process.env.SIDECAR_URL;
    process.env.SIDECAR_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (prevUrl === undefined) delete process.env.SIDECAR_URL;
    else process.env.SIDECAR_URL = prevUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('OCR 结果既进解读、也回填到证据上（下次不必重做）', async () => {
    const { db, uid, caseId } = makeDb();
    const { fileId } = storeBytes(db, Buffer.from('假图片字节'), 'image/png');
    const evId = Number(
      db
        .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
        .run(caseId, uid, fileId, '解除通知.png').lastInsertRowid,
    );
    const llm = fakeLlm({
      summary: '要点',
      advice: '不签',
      advice_detail: '细节',
      findings: [{ rule_id: 'xsjc-001', clause_ref: '因本人个人原因申请离职', issue: '定性错了' }],
    });

    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, evidenceId: evId, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };
    expect(quoted.needs_ocr).toBe(true);

    const done = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, evidenceId: evId, docKind: '解除通知', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };

    expect(done.doc.ocr_text).toBe(OCR_TEXT);
    expect(done.doc.findings[0].severity).toBe('must');
    const ev = db
      .prepare('SELECT extraction_status, extracted_text FROM evidence WHERE id=?')
      .get(evId) as { extraction_status: string; extracted_text: string };
    expect(ev.extraction_status).toBe('done');
    expect(ev.extracted_text).toBe(OCR_TEXT);
  });
});

describe('⑥ 重放：同一张报价不二扣、不二写、不再调模型', () => {
  test('第二次带同一个 quote_id 回 deduped，行数与余额不动', async () => {
    const { db, uid, caseId } = makeDb();
    const llm = fakeLlm();
    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };
    const first = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };
    const after = { balance: getGongdao(uid, db), docs: count(db, 'company_docs'), calls: llm.calls.length };

    const again = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };

    expect(again.deduped).toBe(true);
    expect(again.charged).toBe(0);
    expect(again.doc.id).toBe(first.doc.id);
    expect(getGongdao(uid, db)).toBe(after.balance);
    expect(count(db, 'company_docs')).toBe(after.docs);
    expect(llm.calls.length).toBe(after.calls);
  });
});

describe('⑦ 别人的解读一律「不存在」', () => {
  test('doc_get 拿别人的 doc_id 回 null，doc_list 回空', async () => {
    const { db, uid, other, caseId } = makeDb();
    const llm = fakeLlm();
    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };
    const done = mustOk(
      await submitDoc(
        db,
        { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quoteId },
        { llm },
      ),
    ) as DocReviewResult & { ok: true };

    expect(getDoc(db, done.doc.id, uid)).not.toBeNull();
    expect(getDoc(db, done.doc.id, other)).toBeNull();
    expect(listDocs(db, caseId, other)).toEqual([]);
    // 正对照：本人读得到，断言不是落在「谁都读不到」上
    expect(listDocs(db, caseId, uid)).toHaveLength(1);
  });
});

// ⑧ 报价与这次请求对不上：钱必须原路退回，且账上两笔挂同一个功能名。
//
// 这两条判据钉的是同一类事故：确认扣费发生在校验之前，于是「参数不对」这种最普通的错误
// 变成了「扣了 N 公道值、一个字都没解读、也不退」——而回包看起来只是一条 400，
// 用户照着提示重新报一次价再确认，第二次又付一次。
describe('⑧ 报价对不上这次请求：已扣的钱原路退回', () => {
  /** 账上这个 ref 的扣费与退款两笔（退款 ref 是 `refund-<扣费 ref>`）。 */
  function ledgerPair(db: Database.Database, uid: number) {
    return db
      .prepare(
        "SELECT delta, type, ref_id, feature FROM gongdao_ledger" +
          " WHERE user_id=? AND (ref_id LIKE 'svc-%' OR ref_id LIKE 'refund-svc-%') ORDER BY id",
      )
      .all(uid) as { delta: number; type: string; ref_id: string; feature: string }[];
  }

  test('B2 拿甲案件的报价去解读乙案件：回 QUOTE_CASE_MISMATCH，余额分毫不动', async () => {
    const { db, uid, caseId } = makeDb();
    const caseB = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '同一人的第二个案件')
        .lastInsertRowid,
    );
    const llm = fakeLlm();
    const before = getGongdao(uid, db);

    const quoted = mustOk(
      await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm }),
    ) as DocQuoteResult & { ok: true };

    const r = await submitDoc(
      db,
      { userId: uid, caseId: caseB, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quoteId },
      { llm },
    );

    expect(r.ok).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('QUOTE_CASE_MISMATCH');
    // 要害就是这一行：报错本身不是事故，扣了不退才是。
    expect(getGongdao(uid, db)).toBe(before);
    expect(count(db, 'company_docs')).toBe(0);
    expect(llm.calls.length).toBe(0);
    // 退款不是靠「没扣」蒙对的：账上必须一扣一退两笔，且挂同一个功能名。
    const rows = ledgerPair(db, uid);
    expect(rows.map((x) => x.delta)).toEqual([-PER_DOC, PER_DOC]);
    expect(rows[1].ref_id).toBe(`refund-${rows[0].ref_id}`);
    expect(rows[0].feature).toBe('doc_review');
    expect(rows[1].feature).toBe(rows[0].feature);
  });

  test('B1 拿一张文字识别的报价来解读：回 QUOTE_SERVICE_MISMATCH，不按 5 块钱做 20 块的事', async () => {
    const { db, uid, caseId } = makeDb();
    const llm = fakeLlm();
    const before = getGongdao(uid, db);
    const perPage = PRICE_FALLBACK['ocr.per_page'];
    expect(perPage).not.toBe(PER_DOC); // 正对照：两个价不同，否则这条判据什么都没测

    const cheap = quoteService(db, {
      userId: uid,
      caseId,
      service: 'ocr',
      payload: { units: 1 },
    });
    expect(cheap.ok).toBe(true);
    const quoteId = (cheap as { quote: { quoteId: number } }).quote.quoteId;

    const r = await submitDoc(
      db,
      { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId },
      { llm },
    );

    expect(r.ok).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('QUOTE_SERVICE_MISMATCH');
    expect(count(db, 'company_docs')).toBe(0);
    expect(llm.calls.length).toBe(0);
    expect(getGongdao(uid, db)).toBe(before);
    // 退的那笔挂的是**真扣的那个服务**的功能名（ocr），不是写死的 doc_review。
    const rows = ledgerPair(db, uid);
    expect(rows.map((x) => x.delta)).toEqual([-perPage, perPage]);
    expect(rows[0].feature).toBe('ocr');
    expect(rows[1].feature).toBe(rows[0].feature);
  });
});
