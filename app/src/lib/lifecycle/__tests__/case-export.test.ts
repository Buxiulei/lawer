// app/src/lib/lifecycle/__tests__/case-export.test.ts
// 整案导出：包里到底有什么。
//
// 【为什么判据要断言「包内清单」而不是「回包 200」】一份 zip 打得开、字段齐全、
// HTTP 200，但里面少了对话、少了原件、或者多了一把还能用的分享令牌——这四种情形
// 在回包上完全同形。所以这里逐条断言：清单里有哪几个文件、档案 JSON 里有哪几张表、
// 哪些列被滤掉了、少装的那几项有没有出现在 omissions 里。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'case-export-'));
process.env.FILES_DIR = FILES_DIR;

import { runMigrations } from '@/lib/db/migrate';
import { readBytes, storeBytes } from '@/lib/evidence/files';
import { createShare } from '@/lib/shares';

import { EXPORT_BYTE_BUDGET, collectCaseArchive, exportCase, tablesWithCaseId } from '../case-export';
import { listZipEntries } from '../zip';

let db: Database.Database;
let uid: number;
let other: number;
let caseId: number;

const FAKE_PDF = Buffer.from('%PDF-1.4 假导出件\n%%EOF');
const renderPdf = async () => FAKE_PDF;

beforeAll(() => {
  process.env.LAWER_DATA_KEY ??= crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare("INSERT INTO users (email) VALUES ('a@t.com')").run().lastInsertRowid);
  other = Number(db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '甲的档案').lastInsertRowid,
  );
});

/** 把包从 files 表里取回来（导出件与证据原件走同一条落盘路径）。 */
function zipOf(sha256: string): Buffer {
  const row = db.prepare('SELECT id FROM files WHERE sha256 = ?').get(sha256) as { id: number };
  return readBytes(db, row.id);
}

function seedFullCase(): { evidenceId: number; draftId: number } {
  const { fileId } = storeBytes(db, Buffer.from('这是一份工资条原件'), 'text/plain');
  const evidenceId = Number(
    db
      .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, '工资条.txt').lastInsertRowid,
  );
  const draftId = Number(
    db
      .prepare("INSERT INTO drafts (case_id, kind, title, content) VALUES (?,'异议函','我的异议函','正文若干')")
      .run(caseId).lastInsertRowid,
  );
  const threadId = Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '陪跑')").run(caseId).lastInsertRowid,
  );
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', '我该怎么办')").run(threadId);
  db.prepare("INSERT INTO emotion_log (case_id, level, note) VALUES (?, '焦虑', '睡不着')").run(caseId);
  db.prepare(
    "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, '2026-09-01 00:00:00', '公司动作', '约谈')",
  ).run(caseId);
  return { evidenceId, draftId };
}

describe('包内清单', () => {
  it('档案 + 文书 PDF + 证据原件 + 清单 + 说明，五样齐（变异：把 messages 那一段删掉 → 下一条红）', async () => {
    seedFullCase();
    const res = await exportCase({ db, caseId, userId: uid, renderPdf });
    if (!res.ok) throw new Error(`导出失败：${res.message}`);

    expect(res.entries).toContain('档案.json');
    expect(res.entries).toContain('清单.json');
    expect(res.entries).toContain('README.txt');
    expect(res.entries.some((e) => e.startsWith('文书/') && e.endsWith('.pdf'))).toBe(true);
    expect(res.entries.some((e) => e.startsWith('证据原件/'))).toBe(true);
    expect(res.omissions).toEqual([]);

    // 断言的是**包本身**，不是回包里那份 entries 数组：两者分叉时，
    // 只看 entries 的判据会替一个内容缺失的包背书。
    const names = listZipEntries(zipOf(res.sha256)).map((e) => e.name);
    expect(names.sort()).toEqual([...res.entries].sort());
  });

  it('对话记录在包里（messages 不带 case_id，漏掉它的形态是一份「完整副本」里一句对话都没有）', async () => {
    seedFullCase();
    const res = await exportCase({ db, caseId, userId: uid, renderPdf });
    if (!res.ok) throw new Error('导出失败');
    const archive = JSON.parse(readEntry(zipOf(res.sha256), '档案.json')) as {
      tables: Record<string, unknown[]>;
    };
    expect(archive.tables.messages).toHaveLength(1);
    expect(JSON.stringify(archive.tables.messages)).toContain('我该怎么办');
  });

  it('凡是带 case_id 的表都进了包（表名现查，不是手抄的一张清单）', async () => {
    seedFullCase();
    const rows = collectCaseArchive(db, caseId);
    const exported = new Set(rows.map((r) => r.table));
    for (const t of tablesWithCaseId(db)) expect(exported.has(t), `${t} 没进包`).toBe(true);
    expect(exported.has('cases')).toBe(true);
    expect(exported.has('messages')).toBe(true);
    // 正对照：库里确实有一批这样的表，名单不是空的
    expect(tablesWithCaseId(db).length).toBeGreaterThanOrEqual(10);
  });

  it('分享令牌不进包（变异：把 isSecretColumn 改成恒 false → 本条红）', async () => {
    const { draftId } = seedFullCase();
    const share = createShare(db, { userId: uid, draftId });
    if (!share.ok) throw new Error('建链接失败');

    const res = await exportCase({ db, caseId, userId: uid, renderPdf });
    if (!res.ok) throw new Error('导出失败');
    const archive = readEntry(zipOf(res.sha256), '档案.json');
    // 那条链接的行本身在（用户有权知道自己建过），但**明文令牌一个字都不在**
    expect(archive).toContain('share_links');
    expect(archive).not.toContain(share.token);
  });
});

describe('洞必须看得见', () => {
  it('渲染服务挂了：整次导出照常成功，那份文书进 omissions（变异：把 catch 改成 return fail → 本条红）', async () => {
    seedFullCase();
    const res = await exportCase({
      db,
      caseId,
      userId: uid,
      renderPdf: async () => {
        throw new Error('sidecar 503');
      },
    });
    if (!res.ok) throw new Error('渲染失败不该让整次导出失败');
    expect(res.omissions.map((o) => o.path)).toContain('文书/1-我的异议函.pdf');
    expect(res.omissions[0].reason).toContain('sidecar 503');
    // 少了东西就必须在 note 里说出来，不能让调用方把它当成完整副本
    expect(res.note).toContain('不要把这次导出说成完整副本');
  });

  it('原件在盘上读不回来：进 omissions，登记信息仍在档案 JSON 里', async () => {
    seedFullCase();
    const res = await exportCase({
      db,
      caseId,
      userId: uid,
      renderPdf,
      readFile: () => {
        throw new Error('密文缺失');
      },
    });
    if (!res.ok) throw new Error('导出失败');
    expect(res.omissions.some((o) => o.path.startsWith('证据原件/'))).toBe(true);
    expect(readEntry(zipOf(res.sha256), '档案.json')).toContain('工资条.txt');
  });

  it('清单.json 里的 omissions 与回包一致（包内外两份说法必须同一份）', async () => {
    seedFullCase();
    const res = await exportCase({
      db,
      caseId,
      userId: uid,
      renderPdf: async () => {
        throw new Error('渲染不出来');
      },
    });
    if (!res.ok) throw new Error('导出失败');
    const manifest = JSON.parse(readEntry(zipOf(res.sha256), '清单.json')) as {
      omissions: { path: string }[];
    };
    expect(manifest.omissions.map((o) => o.path)).toEqual(res.omissions.map((o) => o.path));
  });

  it('单包字节上限是有牙的：预算被调到 0 时原件不进包而进 omissions', async () => {
    // 这里不改常量，而是造一份比预算还大的原件——常量真的被读了，才算验过它
    expect(EXPORT_BYTE_BUDGET).toBeGreaterThan(0);
    seedFullCase();
    const huge = Buffer.alloc(16, 7);
    const res = await exportCase({
      db,
      caseId,
      userId: uid,
      renderPdf,
      readFile: () => Buffer.concat([huge, Buffer.alloc(EXPORT_BYTE_BUDGET, 1)]),
    });
    if (!res.ok) throw new Error('导出失败');
    expect(res.omissions.some((o) => o.reason.includes('超出单包上限'))).toBe(true);
  });
});

describe('归属', () => {
  it('别人的案子导不出来，回的是同一句 CASE_NOT_FOUND', async () => {
    seedFullCase();
    const res = await exportCase({ db, caseId, userId: other, renderPdf });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errorCode).toBe('CASE_NOT_FOUND');
    // 零副作用：没有为这次失败落下任何一份导出件
    expect((db.prepare("SELECT COUNT(*) AS n FROM files WHERE mime='application/zip'").get() as { n: number }).n).toBe(0);
  });

  it('已删除的案子导不出来（软删之后导出这条路也要关上）', async () => {
    seedFullCase();
    db.prepare("UPDATE cases SET deleted_at = '2026-09-01 00:00:00' WHERE id = ?").run(caseId);
    const res = await exportCase({ db, caseId, userId: uid, renderPdf });
    expect(!res.ok && res.errorCode).toBe('CASE_NOT_FOUND');
  });
});

describe('下载地址', () => {
  it('签的是一次性限时地址，且落了一份 zip 到 files 表', async () => {
    seedFullCase();
    const res = await exportCase({ db, caseId, userId: uid, renderPdf });
    if (!res.ok) throw new Error('导出失败');
    expect(res.download_url).toContain('/api/v1/files/download/');
    const token = db
      .prepare('SELECT consumed_at, expires_at, filename, mime FROM file_download_tokens ORDER BY id DESC LIMIT 1')
      .get() as { consumed_at: string | null; expires_at: string; filename: string; mime: string };
    expect(token.consumed_at).toBeNull();
    expect(token.mime).toBe('application/zip');
    expect(token.filename).toBe(res.filename);
  });
});

/** 从 zip 里取一个条目的内容（只认 buildZip 的产物：存储法、无扩展字段）。 */
function readEntry(zip: Buffer, name: string): string {
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const size = zip.readUInt32LE(p + 18);
    const entryName = zip.subarray(p + 30, p + 30 + nameLen).toString('utf-8');
    const start = p + 30 + nameLen + extraLen;
    if (entryName === name) return zip.subarray(start, start + size).toString('utf-8');
    p = start + size;
  }
  throw new Error(`包里没有 ${name}`);
}
