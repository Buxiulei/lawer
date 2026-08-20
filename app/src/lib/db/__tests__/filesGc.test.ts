// app/src/lib/db/__tests__/filesGc.test.ts
// files 孤儿回收（scripts/gc-files.ts 的逻辑本体）：三类引用者各建一行 + 一个孤儿，
// 只有孤儿被认领、被删、被回调删盘——漏认一个引用者就等于误删用户证据的密文文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import { findOrphanFiles, gcOrphanFiles, gcFilesCli } from '../filesGc';

let db: Database.Database;

/** 落一行 files，返回 id。enc_path 用 sha 编，便于断言回调收到的是哪一个。 */
function mkFile(target: Database.Database, sha: string, size: number): number {
  return Number(
    target.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
      .run(sha, size, `${sha.slice(0, 2)}/${sha}.enc`).lastInsertRowid,
  );
}

/** 三类引用者各挂一个文件 + 一个无人引用的孤儿；返回各自的 file_id。 */
function seed(target: Database.Database) {
  const uid = Number(
    target.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid,
  );
  const caseId = Number(
    target.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '测试案件').lastInsertRowid,
  );

  const evFile = mkFile(target, 'aa11', 10);
  const docFile = mkFile(target, 'bb22', 20);
  const certFile = mkFile(target, 'cc33', 30);
  const orphan = mkFile(target, 'dd44', 40);

  target.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
    .run(caseId, uid, evFile, '劳动合同');
  target.prepare('INSERT INTO company_docs (case_id, file_id, doc_type) VALUES (?,?,?)')
    .run(caseId, docFile, '解除通知');
  // 出证证书 PDF：attestations.cert_pdf_file_id 可空，也是最容易在引用者清单里被漏掉的一处
  target.prepare('INSERT INTO attestations (order_no, sha256, cert_pdf_file_id) VALUES (?,?,?)')
    .run('att-1', 'cc33', certFile);

  return { uid, caseId, evFile, docFile, certFile, orphan };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

describe('findOrphanFiles', () => {
  test('三类引用者各占一行时，只报无人引用的那一个', () => {
    const { orphan } = seed(db);
    const got = findOrphanFiles(db);
    expect(got.map((r) => r.id)).toEqual([orphan]);
    expect(got[0]).toMatchObject({ sha256: 'dd44', size: 40, enc_path: 'dd/dd44.enc' });
    expect(got[0].created_at).toBeTruthy();
  });

  test('引用行被删（如删案级联删证据）后，原被引用的文件变成孤儿', () => {
    const { caseId, evFile, docFile, orphan } = seed(db);
    db.prepare('DELETE FROM cases WHERE id=?').run(caseId); // evidence + company_docs 一起级联走
    expect(findOrphanFiles(db).map((r) => r.id).sort()).toEqual([evFile, docFile, orphan].sort());
  });

  test('空库无孤儿', () => {
    expect(findOrphanFiles(db)).toEqual([]);
  });
});

describe('gcOrphanFiles', () => {
  test('只删孤儿行，三类被引用文件全部存活；回调恰好收到孤儿的 enc_path', () => {
    const { evFile, docFile, certFile, orphan } = seed(db);
    const deleted: string[] = [];

    const r = gcOrphanFiles(db, { deleteFromDisk: (p) => void deleted.push(p) });

    expect(r).toEqual({ removed: 1, freedBytes: 40 });
    expect(deleted).toEqual(['dd/dd44.enc']);
    const left = (db.prepare('SELECT id FROM files ORDER BY id').all() as { id: number }[]).map((x) => x.id);
    expect(left).toEqual([evFile, docFile, certFile]);
    expect(left).not.toContain(orphan);
  });

  test('多个孤儿：逐个删并累加释放字节', () => {
    seed(db);
    mkFile(db, 'ee55', 5);
    mkFile(db, 'ff66', 7);
    const deleted: string[] = [];
    const r = gcOrphanFiles(db, { deleteFromDisk: (p) => void deleted.push(p) });
    expect(r).toEqual({ removed: 3, freedBytes: 52 });
    expect(deleted).toEqual(['dd/dd44.enc', 'ee/ee55.enc', 'ff/ff66.enc']);
  });

  test('无孤儿时不删不回调', () => {
    const { orphan } = seed(db);
    db.prepare('DELETE FROM files WHERE id=?').run(orphan);
    const deleted: string[] = [];
    expect(gcOrphanFiles(db, { deleteFromDisk: (p) => void deleted.push(p) })).toEqual({
      removed: 0,
      freedBytes: 0,
    });
    expect(deleted).toEqual([]);
  });

  test('删盘回调抛错 → 整个事务回滚，files 行一个不少（宁可留垃圾也不留坏行）', () => {
    seed(db);
    expect(() =>
      gcOrphanFiles(db, {
        deleteFromDisk: () => {
          throw new Error('EACCES');
        },
      }),
    ).toThrow(/EACCES/);
    expect((db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(4);
  });
});

/** CLI 本体要真开一个库文件（内存库进不了 dbPath），故落一个临时库再跑。 */
describe('gcFilesCli', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-gc-')), 'lawer.db');
    const file = new Database(dbPath);
    file.pragma('foreign_keys = ON');
    runMigrations(file);
    seed(file);
    file.close();
  });

  test('dry-run：只读打开、一行不删、不碰盘', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deleted: string[] = [];
    expect(gcFilesCli(dbPath, { dryRun: true, deleteFromDisk: (p) => void deleted.push(p) })).toBe(0);
    log.mockRestore();

    expect(deleted).toEqual([]);
    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(4);
    after.close();
  });

  test('--delete：孤儿行落地删除，被引用文件存活', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deleted: string[] = [];
    expect(gcFilesCli(dbPath, { dryRun: false, deleteFromDisk: (p) => void deleted.push(p) })).toBe(0);
    log.mockRestore();

    expect(deleted).toEqual(['dd/dd44.enc']);
    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT sha256 FROM files ORDER BY id').all() as { sha256: string }[])
      .map((r) => r.sha256)).toEqual(['aa11', 'bb22', 'cc33']);
    after.close();
  });
});
