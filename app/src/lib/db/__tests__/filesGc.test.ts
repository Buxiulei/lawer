// app/src/lib/db/__tests__/filesGc.test.ts
// files 孤儿回收（scripts/gc-files.ts 的逻辑本体）：五类引用者各建一行 + 一个孤儿，
// 只有孤儿被认领、被删、被回调删盘——漏认一个引用者就等于误删用户证据的密文文件。
//
// 【为什么本文件全程 foreign_keys = ON】生产的 Next 进程就是这么开库的（lib/db/client）。
// 关着外键跑，漏认一个引用者只表现为"多删了一行"；开着外键跑，它表现为 DELETE 抛
// FOREIGN KEY constraint failed、**整个事务回滚**，于是本轮已经 unlink 掉的低 id 孤儿
// 库行原地复活成「有记录无密文」的坏行，而且一个孤儿都回收不掉。后者才是产线的形态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import { findOrphanFiles, gcOrphanFiles, gcOrphanFilesAmong, gcFilesCli, REFERENCERS } from '../filesGc';
import { caseScopedReferencers, listCaseFileIds } from '../lifecycle';

let db: Database.Database;

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** 落一行 files，返回 id。enc_path 用 sha 编，便于断言回调收到的是哪一个。 */
function mkFile(target: Database.Database, sha: string, size: number): number {
  return Number(
    target.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
      .run(sha, size, `${sha.slice(0, 2)}/${sha}.enc`).lastInsertRowid,
  );
}

/** 五类引用者各挂一个文件 + 一个无人引用的孤儿；返回各自的 file_id。 */
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
  // 孤儿的 id 刻意排在两张令牌表引着的文件**前面**：事务里逐行删，孤儿先被 unlink，
  // 随后那两行才撞外键。漏认引用者时的坏行（有记录无密文）就是这样造出来的。
  const orphan = mkFile(target, 'dd44', 40);
  const upFile = mkFile(target, 'ab55', 50);
  const dlFile = mkFile(target, 'ac66', 60);

  target.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
    .run(caseId, uid, evFile, '劳动合同');
  target.prepare('INSERT INTO company_docs (case_id, file_id, doc_type) VALUES (?,?,?)')
    .run(caseId, docFile, '解除通知');
  // 出证证书 PDF：attestations.cert_pdf_file_id 可空，也是最容易在引用者清单里被漏掉的一处
  target.prepare('INSERT INTO attestations (order_no, sha256, cert_pdf_file_id) VALUES (?,?,?)')
    .run('att-1', 'cc33', certFile);
  // 上传令牌：字节落库后回填 file_id，登记成 evidence 之前只有它引着那份密文
  target.prepare(
    `INSERT INTO evidence_upload_tokens (token_hash, case_id, user_id, filename, expires_at, file_id)
     VALUES ('uh', ?, ?, '录音.m4a', '2030-01-01 00:00:00', ?)`,
  ).run(caseId, uid, upFile);
  // 下载令牌：整案导出与文书导出各签一条，**这张表从不删行**，所以它引着的文件长期不是孤儿
  target.prepare(
    `INSERT INTO file_download_tokens (token_hash, file_id, user_id, filename, expires_at)
     VALUES ('dh', ?, ?, '整案副本.zip', '2030-01-01 00:00:00')`,
  ).run(dlFile, uid);

  return { uid, caseId, evFile, docFile, certFile, orphan, upFile, dlFile };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

describe('findOrphanFiles', () => {
  test('五类引用者各占一行时，只报无人引用的那一个', () => {
    const { orphan } = seed(db);
    const got = findOrphanFiles(db);
    expect(got.map((r) => r.id)).toEqual([orphan]);
    expect(got[0]).toMatchObject({ sha256: 'dd44', size: 40, enc_path: 'dd/dd44.enc' });
    expect(got[0].created_at).toBeTruthy();
  });

  test('引用行被删（如删案级联删证据）后，原被引用的文件变成孤儿', () => {
    const { caseId, evFile, docFile, orphan, upFile, dlFile } = seed(db);
    // evidence + company_docs + evidence_upload_tokens 都挂 case_id，一起级联走
    db.prepare('DELETE FROM cases WHERE id=?').run(caseId);
    expect(findOrphanFiles(db).map((r) => r.id).sort()).toEqual(
      [evFile, docFile, orphan, upFile].sort(),
    );
    // 下载令牌挂的是 user_id 不是 case_id：删案带不走它，那份导出件仍然有人引着
    expect(findOrphanFiles(db).map((r) => r.id)).not.toContain(dlFile);
  });

  test('空库无孤儿', () => {
    expect(findOrphanFiles(db)).toEqual([]);
  });
});

describe('gcOrphanFiles', () => {
  test('只删孤儿行，五类被引用文件全部存活；回调恰好收到孤儿的 enc_path', () => {
    const { evFile, docFile, certFile, orphan, upFile, dlFile } = seed(db);
    const deleted: string[] = [];

    const r = gcOrphanFiles(db, { deleteFromDisk: (p) => void deleted.push(p) });

    expect(r).toEqual({ removed: 1, freedBytes: 40 });
    expect(deleted).toEqual(['dd/dd44.enc']);
    const left = (db.prepare('SELECT id FROM files ORDER BY id').all() as { id: number }[]).map((x) => x.id);
    expect(left).toEqual([evFile, docFile, certFile, upFile, dlFile]);
    expect(left).not.toContain(orphan);
  });

  /**
   * 复审 blocker 的回归判据（2026-09-07）。这一条与上一条不是同一件事：上一条问「有没有多删」，
   * 这一条问「漏认一个引用者时会怎样」——在 foreign_keys=ON 的进程里答案不是"多删一行"，
   * 而是**一个孤儿都收不掉，还留下一行有记录无密文的坏行**。
   *
   * 变异：把 REFERENCERS 里的 file_download_tokens（或 evidence_upload_tokens）那一行删掉 → 本条红。
   */
  test('两张令牌表引着的文件不是孤儿：开着外键跑不抛、孤儿照收、坏行不产生', () => {
    const { orphan, upFile, dlFile } = seed(db);
    expect(db.pragma('foreign_keys', { simple: true }), '本用例必须开着外键跑').toBe(1);
    const deleted: string[] = [];

    // ① 不抛：漏认引用者时这里是 SqliteError: FOREIGN KEY constraint failed
    const r = gcOrphanFiles(db, { deleteFromDisk: (p) => void deleted.push(p) });

    // ② 孤儿真被收掉了（回滚的形态下 removed=0、库里那一行还在）
    expect(r.removed).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', orphan)).toBe(0);
    // ③ 没有「盘上已删、库行还在」的坏行：删过盘的恰好就是库里已经没有的那一个
    expect(deleted).toEqual(['dd/dd44.enc']);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id IN (?,?)', upFile, dlFile)).toBe(2);
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
    expect((db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(6);
  });
});

// ───────────────────── 候选集版：常驻清理任务用的那个 ─────────────────────
//
// 【为什么另有一个】全库版问的是「此刻谁没人引用」，而"没人引用"只认表上的外键——
// file_id 只写在别处（例如护照实名那段加密 JSON）的文件，在它眼里就是垃圾。
// 人工 CLI 那样用没问题（dry-run 默认、有人看着输出）；每小时自动跑一轮的常驻任务不行。
// 所以 lib/jobs/retention-worker 只回收**它自己这一轮删掉引用者的那批**。
describe('gcOrphanFilesAmong', () => {
  test('候选集之外的孤儿一行不动（这正是常驻任务与全库 CLI 的差别）', () => {
    const { evFile, orphan } = seed(db);
    const deleted: string[] = [];

    // 候选集里给的是"还被引用着"的那一份，真孤儿根本不在候选集里
    const r = gcOrphanFilesAmong(db, [evFile], { deleteFromDisk: (p) => void deleted.push(p) });

    expect(r).toEqual({ removed: 0, freedBytes: 0 });
    expect(deleted).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', orphan), '候选集外的行被删了').toBe(1);
  });

  test('删案释放出来的那批被收掉，跨案共享的同一份不收（判据仍是「无人引用」）', () => {
    const { uid, caseId, evFile, docFile, upFile, certFile, dlFile, orphan } = seed(db);
    // 另一个案子引着同一份原件：它必须活下来
    const otherCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '另一个案子').lastInsertRowid,
    );
    db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(otherCase, uid, evFile, '同一份原件');

    // 候选集必须在硬删**之前**取：级联一发生就再也问不出来了
    const released = listCaseFileIds(db, caseId);
    expect([...released].sort(), '释放清单不是三张挂 case_id 的引用表').toEqual(
      [evFile, docFile, upFile].sort(),
    );
    db.prepare('DELETE FROM cases WHERE id=?').run(caseId);

    const deleted: string[] = [];
    const r = gcOrphanFilesAmong(db, released, { deleteFromDisk: (p) => void deleted.push(p) });

    expect(r.removed, '该收的两份没收全').toBe(2);
    expect(deleted.sort()).toEqual(['ab/ab55.enc', 'bb/bb22.enc']);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', evFile), '把别人还在用的原件删了').toBe(1);
    // 候选集外的三个一律没动：证书 PDF、下载令牌引着的、以及那个真孤儿
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id IN (?,?,?)', certFile, dlFile, orphan)).toBe(3);
  });

  test('重复的 id 只处置一次，已经不存在的 id 不炸', () => {
    const { caseId } = seed(db);
    const released = listCaseFileIds(db, caseId);
    db.prepare('DELETE FROM cases WHERE id=?').run(caseId);
    const deleted: string[] = [];

    const r = gcOrphanFilesAmong(db, [...released, ...released, 99999], {
      deleteFromDisk: (p) => void deleted.push(p),
    });

    expect(r.removed).toBe(3);
    expect(deleted).toHaveLength(3);
    expect(new Set(deleted).size, '同一份文件被删了两次').toBe(3);
  });
});

describe('结构守卫：随案件一起释放的引用表是推出来的，不是手抄的', () => {
  test('恰好是 REFERENCERS 里带 case_id 列的那三张（变异：手抄漏一张 → 这里点名）', () => {
    expect(caseScopedReferencers(db).map(([t, c]) => `${t}.${c}`).sort()).toEqual([
      'company_docs.file_id',
      'evidence.file_id',
      'evidence_upload_tokens.file_id',
    ]);
    // 反向：不挂 case_id 的两张不许混进来——它们不随删案消失，混进来就是误删
    expect(caseScopedReferencers(db).map(([t]) => t)).not.toContain('attestations');
    expect(caseScopedReferencers(db).map(([t]) => t)).not.toContain('file_download_tokens');
  });
});

// ───────────────────────────── 结构守卫 ─────────────────────────────
//
// 【为什么守卫读的是 migrate.ts 的源码，而不是再抄一份表名清单】这份清单已经漏过一次：
// 抬头写着"日后任何表新增 files 外键必须同步加进 REFERENCERS"，然后两张令牌表各加了一列
// 外键，谁都没回来改。**独立写 N 次就会忘 N 次**——所以判据不问人记没记得，
// 直接从建表语句里把全部 `REFERENCES files(id)` 抽出来比对，漏哪张点名哪张。
describe('结构守卫：REFERENCERS 覆盖 migrate.ts 里全部 files 外键', () => {
  const MIGRATE = fs.readFileSync(
    path.join(fileURLToPath(new URL('..', import.meta.url)), 'migrate.ts'),
    'utf-8',
  );

  /** 从建表语句里抽 (表名, 指向 files.id 的列名)。 */
  function declaredReferencers(src: string): string[] {
    const out: string[] = [];
    let table: string | null = null;
    for (const line of src.split('\n')) {
      const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
      if (create) table = create[1];
      if (!/REFERENCES\s+files\s*\(/i.test(line)) continue;
      const col = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line);
      // 认不出所在表或列名就抛：宁可让守卫自己坏掉，也不许它悄悄少数一条
      if (!table || !col) throw new Error(`认不出这一行的表/列：${line.trim()}`);
      out.push(`${table}.${col[1]}`);
    }
    return out.sort();
  }

  test('两份清单逐条相等（变异：往 migrate.ts 加一张引 files 的表而不改 REFERENCERS → 本条红）', () => {
    const declared = declaredReferencers(MIGRATE);
    // 正对照：抽取器真的抽到了东西，不是拿两个空数组互相印证
    expect(declared.length).toBeGreaterThanOrEqual(5);
    // 抽取器没有漏掉任何一处 `REFERENCES files`（例如日后写成 ALTER TABLE ADD COLUMN）
    expect(declared).toHaveLength((MIGRATE.match(/REFERENCES\s+files\s*\(/gi) ?? []).length);
    expect([...REFERENCERS].map(([t, c]) => `${t}.${c}`).sort()).toEqual(declared);
  });
});

/** CLI 本体要真开一个库文件（内存库进不了 dbPath），故落一个临时库再跑。 */
describe('gcFilesCli', () => {
  let dbPath: string;

  // 超时给到 30 秒：这个 hook 要在**真文件**上跑一遍全量迁移（内存库那条路快得多），
  // 全量套件并发跑时它逼近 vitest 默认的 10 秒 hook 上限，偶发红一次。
  // 红的时候看起来像"回收逻辑坏了"，其实是这一句建库超时——把上限调到它真实需要的量级，
  // 好过让人下次去查一个不存在的回收 bug。
  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-gc-')), 'lawer.db');
    const file = new Database(dbPath);
    file.pragma('foreign_keys = ON');
    runMigrations(file);
    seed(file);
    file.close();
  }, 30_000);

  test('dry-run：只读打开、一行不删、不碰盘', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deleted: string[] = [];
    expect(gcFilesCli(dbPath, { dryRun: true, deleteFromDisk: (p) => void deleted.push(p) })).toBe(0);
    log.mockRestore();

    expect(deleted).toEqual([]);
    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(6);
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
      .map((r) => r.sha256)).toEqual(['aa11', 'bb22', 'cc33', 'ab55', 'ac66']);
    after.close();
  });
});
