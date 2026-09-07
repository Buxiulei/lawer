// app/src/lib/drafts/__tests__/export-sensitive.test.ts
// 敏感级出口二的**另一半**：导出 PDF（设计稿 §16「分享/导出对来访者信息强制脱敏」）。
//
// 【为什么导出这一半要单独钉】分享页与导出是两条代码路径，只是结局一样——
// 交出去就不在我们手里。只测分享页的形态是：那条路记得脱敏、导出这条忘了，
// 而导出照常返回 200，PDF 打开来什么都不缺，只是它现在在对方的电脑里，
// 而纸上还印着那句声称化名已被替换的说明。
//
// 【判据看的是喂给渲染器的 markdown，不是 PDF 字节】PDF 由 sidecar 渲染，
// 我们能验的、也该验的是**交给它的那段文字**：从这里出去的字就是纸上的字。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import { SENSITIVE_MASK } from '@/lib/sensitive';

/** 渲染器收到的 markdown，每条判据自己清空。 */
let renderedMarkdown: string[] = [];

vi.mock('@/lib/evidence/sidecar-client', () => ({
  renderDraftPdf: async (input: { markdown: string }) => {
    renderedMarkdown.push(input.markdown);
    return Buffer.from('%PDF-1.4 假的导出件\n%%EOF');
  },
}));
// storeBytes 是**同步**的（它的返回值被直接摊平用），mock 成 async 的形态是
// fileId 变成一个 Promise、落库时写进 NULL，而报错停在 agent_writes 那一行的约束上。
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

const VISITOR_PHONE = '13900139002';
const VISITOR_ALIAS = '来访甲乙丙';
const COUNSELING = DOMAINS.counseling;

let exportDraft: typeof import('../export').exportDraft;
let db: Database.Database;
let uid: number;

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  exportDraft = (await import('../export')).exportDraft;
});

beforeEach(() => {
  renderedMarkdown = [];
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('exp').lastInsertRowid);
});

/**
 * 建案 →（可选）走真首诊登记对方称呼 → 起一份内部件 → 走完报价+确认两步，
 * 回渲染器收到的那段 markdown。
 *
 * 【为什么化名走首诊而不是手写一行 SQL】产线上这张表是首诊那一格填进来的；
 * 手写版判据在"首诊改成落别的角色位"那天照样绿，而 PDF 上从此原样印着化名。
 */
async function exportedMarkdown(domain: string, body: string, alias?: string): Promise<string> {
  const pack = DOMAINS[domain];
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(JSON.stringify(made));
  if (alias !== undefined) {
    const done = cases.submitIntake(db, {
      caseId: made.caseId,
      userId: uid,
      stage: pack.stages[0],
      companyName: alias,
      employedFrom: '2024-03-01',
      monthlyWageFen: 800000,
      goals: ['把这件事了结'],
    });
    if (!done.ok) throw new Error(`首诊失败：${JSON.stringify(done)}`);
  }
  const kind = pack.docKinds.find((k) => !pack.outboundDocKinds.includes(k));
  if (!kind) throw new Error(`${domain} 没有内部件可用`);
  const draft = cases.writeDraft(db, {
    caseId: made.caseId,
    userId: uid,
    kind,
    title: '一份记录',
    body,
  });
  if (!draft.ok) throw new Error(JSON.stringify(draft));

  const quoted = await exportDraft(db, { userId: uid, draftId: draft.draft.id });
  if (!quoted.ok) throw new Error(JSON.stringify(quoted));
  const quoteId = (quoted as { quote_id: number }).quote_id;
  const done = await exportDraft(db, { userId: uid, draftId: draft.draft.id, quoteId });
  if (!done.ok) throw new Error(JSON.stringify(done));
  expect(renderedMarkdown.length, '渲染器没被调到，下面断言的是空字符串').toBe(1);
  return renderedMarkdown[0];
}

describe('导出 PDF：敏感级案件强制脱敏 + 附那句说明', () => {
  it('counseling：号码不进 PDF，且 PDF 末尾带脱敏说明（变异：把 pdfBody 改回 body → 红）', async () => {
    const md = await exportedMarkdown('counseling', `联系了 ${VISITOR_PHONE}，未接。`);
    expect(md, '来访者的号码原样印进了导出的 PDF').not.toContain(VISITOR_PHONE);
    expect(md).toContain(SENSITIVE_MASK);
    expect(md).toContain(COUNSELING.sensitive!.redactNotice);
  });

  it('首诊登记的来访化名也不进 PDF（分享页与导出读同一份化名清单）', async () => {
    const md = await exportedMarkdown('counseling', `${VISITOR_ALIAS}今天没有到场。`, VISITOR_ALIAS);
    expect(md, '首诊登记的来访化名原样印进了导出的 PDF').not.toContain(VISITOR_ALIAS);
    expect(md).toContain(SENSITIVE_MASK);
    expect(md).toContain(COUNSELING.sensitive!.redactNotice);
  });

  it('缺省领域**逐字不变**，也不多印那句话（自证这道脱敏不是恒发生）', async () => {
    const body = `蓝海科技有限公司的联系电话 ${VISITOR_PHONE}`;
    const md = await exportedMarkdown(DEFAULT_DOMAIN, body, '蓝海科技有限公司');
    expect(md).toBe(body);
    expect(md).not.toContain(SENSITIVE_MASK);
    expect(md).not.toContain(COUNSELING.sensitive!.redactNotice);
  });
});
