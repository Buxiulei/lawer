// app/src/lib/drafts/__tests__/export-ai-label.test.ts
// 导出的 PDF 里必须带**两种**生成合成内容标识
//（《人工智能生成合成内容标识办法》§4 末款「下载、复制、导出等功能…文件中含有显式标识」；
//  §5「在生成合成内容的文件元数据中添加隐式标识」）。
//
// 【为什么两种都要钉，而且要分开钉】它们在页面上、在回包里都看不出区别：
// 少了显式标识，PDF 照常生成、正文一个字不缺；少了隐式标识，连打开都看不出来。
// 合成一条判据的形态是——某一次只写了显式那半，判据仍然是绿的（另一半没人问）。
//
// 【判据看的是喂给渲染器的 payload】PDF 字节由 sidecar 渲染，那一侧的判据在
// sidecar/tests/test_draft_pdf.py（真渲一份 PDF、用 pypdf 读回文本与元数据）。
// 两侧接得上不接得上，由这里断言的字段名与那边读的字段名对齐。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_GENERATED_LABEL, AI_LABEL_ATTRIBUTE, AI_LABEL_PROVIDER } from '@/lib/ai-label';
import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';

interface DraftPdfPayload {
  title: string;
  markdown: string;
  ai_label?: string;
  ai_meta?: { producer: string; subject: string; keywords: string };
}

let payloads: DraftPdfPayload[] = [];

vi.mock('@/lib/evidence/sidecar-client', () => ({
  renderDraftPdf: async (input: DraftPdfPayload) => {
    payloads.push(input);
    return Buffer.from('%PDF-1.4 假的导出件\n%%EOF');
  },
}));
vi.mock('@/lib/evidence/files', () => ({
  storeBytes: (db: {
    prepare: (sql: string) => { run: (...a: unknown[]) => { lastInsertRowid: number } };
  }) => {
    const id = Number(
      db
        .prepare('INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)')
        .run(`f${Math.random()}`, 24, 'application/pdf', '/dev/null').lastInsertRowid,
    );
    return { fileId: id, sha256: 'a'.repeat(64), size: 24, deduped: false };
  },
}));

let exportDraft: typeof import('../export').exportDraft;
let db: Database.Database;
let uid: number;

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  exportDraft = (await import('../export')).exportDraft;
});

beforeEach(() => {
  payloads = [];
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('ail').lastInsertRowid);
});

/**
 * 各领域挑一种**内部件**：对外件（异议函那一类）要求同时给出「发出后果说明」，
 * 那是另一条判据的事，混进来只会让这份判据挂在一个与标识无关的 400 上。
 */
const INTERNAL_KIND: Record<string, string> = {
  [DEFAULT_DOMAIN]: '其他',
  counseling: '危机处置记录',
};

/** 建案 → 起一份文书 → 走完报价+确认两步，回渲染器收到的那份 payload 与草稿行。 */
async function exportOnce(domain: string): Promise<{ payload: DraftPdfPayload; draftId: number }> {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(JSON.stringify(made));
  const draft = cases.writeDraft(db, {
    caseId: made.caseId,
    userId: uid,
    kind: INTERNAL_KIND[domain],
    title: '一份文书',
    body: '正文若干。',
  });
  if (!draft.ok) throw new Error(JSON.stringify(draft));

  const quoted = await exportDraft(db, { userId: uid, draftId: draft.draft.id });
  if (!quoted.ok) throw new Error(JSON.stringify(quoted));
  const quoteId = (quoted as { quote_id: number }).quote_id;
  const done = await exportDraft(db, { userId: uid, draftId: draft.draft.id, quoteId });
  if (!done.ok) throw new Error(JSON.stringify(done));
  expect(payloads.length, '渲染器没被调到，下面断言的是 undefined').toBe(1);
  return { payload: payloads[0], draftId: draft.draft.id };
}

describe('导出 PDF 的显式标识（标识办法 §4 末款）', () => {
  it('payload 带 ai_label，且是「法定前半句 + 本领域那半句」拼起来的整句（变异：把 ai_label 删掉 → 红）', async () => {
    const { payload } = await exportOnce(DEFAULT_DOMAIN);
    expect(payload.ai_label, '导出的文件里没有任何显式标识').toBeTruthy();
    expect(payload.ai_label).toContain(AI_GENERATED_LABEL);
    expect(payload.ai_label).toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.aiLabelDisclaimer);
  });

  it('第二个领域拿到的是它自己那半句，不是缺省领域那句（变异：写死成缺省包 → 红）', async () => {
    const { payload } = await exportOnce('counseling');
    expect(payload.ai_label).toContain(DOMAINS.counseling.copy.pages.aiLabelDisclaimer);
    expect(
      payload.ai_label,
      '导出件上印着另一个行当的那句话',
    ).not.toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.aiLabelDisclaimer);
  });
});

describe('导出 PDF 的隐式标识（标识办法 §5：属性 + 服务提供者 + 内容编号）', () => {
  it('三要素齐（变异：把 ai_meta 删掉、或去掉其中任一项 → 红）', async () => {
    const { payload, draftId } = await exportOnce(DEFAULT_DOMAIN);
    const meta = payload.ai_meta;
    expect(meta, '文件元数据里没有隐式标识').toBeTruthy();
    // 属性信息
    expect(meta!.subject).toContain(AI_LABEL_ATTRIBUTE);
    // 服务提供者名称
    expect(meta!.producer).toBe(AI_LABEL_PROVIDER);
    // 内容编号：这一份草稿的 id 与版本
    expect(meta!.keywords).toContain(`draft:${draftId}@v1`);
  });

  it('内容编号带版本：改一版再导，编号跟着变（变异：编号只写 draft id → 红）', async () => {
    const made = cases.ensureDefaultCase(db, uid, DEFAULT_DOMAIN);
    if ('ok' in made) throw new Error(JSON.stringify(made));
    const first = cases.writeDraft(db, {
      caseId: made.caseId,
      userId: uid,
      kind: INTERNAL_KIND[DEFAULT_DOMAIN],
      title: '一份文书',
      body: '第一版。',
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const second = cases.writeDraft(db, {
      caseId: made.caseId,
      userId: uid,
      kind: INTERNAL_KIND[DEFAULT_DOMAIN],
      title: '一份文书',
      body: '第二版，改过措辞。',
      basedOnDraftId: first.draft.id,
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    expect(second.draft.version, '这一步没真的产生第二版，下面在验同一版').toBe(2);

    const quoted = await exportDraft(db, { userId: uid, draftId: second.draft.id });
    if (!quoted.ok) throw new Error(JSON.stringify(quoted));
    const done = await exportDraft(db, {
      userId: uid,
      draftId: second.draft.id,
      quoteId: (quoted as { quote_id: number }).quote_id,
    });
    if (!done.ok) throw new Error(JSON.stringify(done));
    expect(payloads[0].ai_meta!.keywords).toContain(`draft:${second.draft.id}@v2`);
  });
});
