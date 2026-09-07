// app/src/lib/drafts/__tests__/export-sensitive.test.ts
// 敏感级的**第二个出口的另一半**：导出 PDF（设计稿 §16「分享/导出对来访者信息强制脱敏」）。
//
// 【为什么导出这一半要单独钉】分享页与导出是两条代码路径，只是结局一样——
// 交出去就不在我们手里。只测分享页的形态是：那条路记得脱敏、导出这条忘了，
// 而导出照常返回 200，PDF 打开来什么都不缺，只是它现在在对方的电脑里。
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
  storeBytes: (db: { prepare: (sql: string) => { run: (...a: unknown[]) => { lastInsertRowid: number } } }) => {
    const id = Number(
      db
        .prepare('INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)')
        .run(`f${Math.random()}`, 24, 'application/pdf', '/dev/null').lastInsertRowid,
    );
    return { fileId: id, sha256: 'a'.repeat(64), size: 24, deduped: false };
  },
}));

const VISITOR_PHONE = '13900139002';
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
 * 建案 → 起一份内部件 → 走完报价+确认两步，回渲染器收到的那段 markdown。
 *
 * `alias` 传了就同时登记成本案的对方称呼（这个领域的 company_profiles 里装的就是来访化名）。
 */
async function exportedMarkdown(
  domain: string,
  kind: string,
  body = `联系了 ${VISITOR_PHONE}，未接。`,
  alias?: string,
): Promise<string> {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(JSON.stringify(made));
  if (alias !== undefined) {
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(made.caseId, alias);
  }
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
  it('counseling 案件：号码不进 PDF，且 PDF 末尾带脱敏说明', async () => {
    const md = await exportedMarkdown('counseling', '危机处置记录');
    expect(md, '来访者的号码原样印进了导出的 PDF').not.toContain(VISITOR_PHONE);
    expect(md).toContain(SENSITIVE_MASK);
    expect(md).toContain(COUNSELING.sensitive!.redactNotice);
  });

  it('已登记的来访化名也不进 PDF（分享页与导出读同一份化名清单）', async () => {
    // 【为什么导出这一半要单独钉】分享页与导出是两条代码路径。只在分享页那条路加上化名替换、
    // 导出这条忘了的形态是：导出照常返回 200，PDF 打开来什么都不缺，只是它现在在对方电脑里，
    // 而纸上印着那句声称化名已被替换的说明。
    const md = await exportedMarkdown(
      'counseling',
      '危机处置记录',
      '来访甲乙丙今天没有到场。',
      '来访甲乙丙',
    );
    expect(md, '已登记的来访化名原样印进了导出的 PDF').not.toContain('来访甲乙丙');
    expect(md).toContain(SENSITIVE_MASK);
    expect(md).toContain(COUNSELING.sensitive!.redactNotice);
  });

  it('缺省领域登记的公司名**不洗**（自证这道化名替换不是恒发生）', async () => {
    const internal = DOMAINS[DEFAULT_DOMAIN].docKinds.find(
      (k) => !DOMAINS[DEFAULT_DOMAIN].outboundDocKinds.includes(k),
    )!;
    const md = await exportedMarkdown(
      DEFAULT_DOMAIN,
      internal,
      '蓝海科技有限公司至今没有答复。',
      '蓝海科技有限公司',
    );
    expect(md).toContain('蓝海科技有限公司');
    expect(md).not.toContain(SENSITIVE_MASK);
  });

  it('缺省领域的同一份文书**逐字不变**，也不多那句说明（自证不是恒脱敏）', async () => {
    const internalKind = DOMAINS[DEFAULT_DOMAIN].docKinds.find(
      (k) => !DOMAINS[DEFAULT_DOMAIN].outboundDocKinds.includes(k),
    )!;
    const md = await exportedMarkdown(DEFAULT_DOMAIN, internalKind);
    expect(md).toContain(VISITOR_PHONE);
    expect(md).not.toContain(SENSITIVE_MASK);
    expect(md).not.toContain(COUNSELING.sensitive!.redactNotice);
  });
});
