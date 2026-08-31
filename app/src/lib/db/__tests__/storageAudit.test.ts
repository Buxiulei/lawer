// app/src/lib/db/__tests__/storageAudit.test.ts
// 存储用量审计：口径正确性 + 两条总账恒等式 + 与 filesGc 引用者清单的结构对齐。
//
// 判据挑选的原则是「错了要有人当场喊」：本模块产出的是一张没人会去核对的数字表，
// 所以每条断言都盯着一种**会给出看起来正常的错数**的写法：
//   字符当字节（中文低报 3 倍）、漏一条归属路径（那类文件永远算 0）、
//   去重写成 UNION ALL（自引两次翻倍）、无主字节被悄悄吞掉（总账对不上却不报）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import { findOrphanFiles, REFERENCERS } from '../filesGc';
import {
  auditStorage,
  getUserStorage,
  checkStorageIdentities,
  humanBytes,
  storageAuditCli,
  OWNER_PATH_KEYS,
  REFERENCER_KEYS,
  type StorageAuditReport,
} from '../storageAudit';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

const mkUser = (email: string) =>
  Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
const mkCase = (uid: number, title = '案件') =>
  Number(db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, title).lastInsertRowid);
const mkFile = (sha: string, size: number) =>
  Number(
    db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
      .run(sha, size, `${sha}.enc`).lastInsertRowid,
  );
const mkEvidence = (caseId: number, uid: number, fileId: number, name = '证据') =>
  Number(
    db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, name).lastInsertRowid,
  );
const mkThread = (caseId: number) =>
  Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid,
  );
const mkMessage = (threadId: number, role: string, content: string | null) =>
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?,?,?)').run(threadId, role, content);

const rowFor = (r: StorageAuditReport, uid: number) => r.users.find((u) => u.user_id === uid);

// ───────────────────────── 量尺本身 ─────────────────────────

describe('对话字节的口径', () => {
  test('中文按 UTF-8 字节计，不是字符数', () => {
    const uid = mkUser('a@t.com');
    const th = mkThread(mkCase(uid));
    mkMessage(th, 'user', '解除通知书'); // 5 字符 / 15 字节

    const row = getUserStorage(db, uid);
    expect(row.message_bytes).toBe(15); // 用 LENGTH(content) 会得到 5
    expect(row.message_count).toBe(1);
  });

  test('中英混排逐字节相加，与 Buffer.byteLength 对齐', () => {
    const uid = mkUser('b@t.com');
    const th = mkThread(mkCase(uid));
    const texts = ['赔偿金 N+1', 'hello', '仲裁申请书（朝阳）'];
    for (const t of texts) mkMessage(th, 'assistant', t);

    const expected = texts.reduce((s, t) => s + Buffer.byteLength(t, 'utf8'), 0);
    expect(expected).toBeGreaterThan(texts.reduce((s, t) => s + t.length, 0)); // 确保这组样本真能区分两种口径
    expect(getUserStorage(db, uid).message_bytes).toBe(expected);
  });

  test('content 为 NULL 的生成中/中断行：数进条数，不占字节', () => {
    const uid = mkUser('c@t.com');
    const th = mkThread(mkCase(uid));
    mkMessage(th, 'user', '问句'); // 6 字节
    mkMessage(th, 'assistant', null); // 生成中

    const row = getUserStorage(db, uid);
    expect(row.message_count).toBe(2);
    expect(row.message_bytes).toBe(6);
  });
});

// ───────────────────────── 归属路径 ─────────────────────────

describe('文件归属', () => {
  test('三条归属路径各自都能把字节算到人头上', () => {
    const uid = mkUser('a@t.com');
    const caseId = mkCase(uid);

    const evFile = mkFile('aa', 100);
    const docFile = mkFile('bb', 200);
    const certFile = mkFile('cc', 400);

    const evId = mkEvidence(caseId, uid, evFile);
    db.prepare('INSERT INTO company_docs (case_id, file_id) VALUES (?,?)').run(caseId, docFile);
    db.prepare('INSERT INTO attestations (order_no, sha256, evidence_id, cert_pdf_file_id) VALUES (?,?,?,?)')
      .run('att-1', 'cc', evId, certFile);

    const row = getUserStorage(db, uid);
    // 100+200+400 的三个 2 的幂：漏掉任何一条路径，和都对不上且能反推出漏的是哪条
    expect(row.file_bytes).toBe(700);
    expect(row.file_count).toBe(3);
  });

  test('同一用户多处引用同一文件只算一次（去重）', () => {
    const uid = mkUser('a@t.com');
    const caseId = mkCase(uid);
    const f = mkFile('aa', 100);
    mkEvidence(caseId, uid, f, '证据一');
    mkEvidence(caseId, uid, f, '证据二'); // 同一份文件，两条证据

    const row = getUserStorage(db, uid);
    expect(row.file_bytes).toBe(100); // UNION ALL 会得到 200
    expect(row.file_count).toBe(1);
    expect(row.evidence_count).toBe(2); // 证据条数照实数两条
  });

  test('两个用户共享同一份文件：各自全额计，总账记重复计数', () => {
    const u1 = mkUser('a@t.com');
    const u2 = mkUser('b@t.com');
    const f = mkFile('shared', 100);
    mkEvidence(mkCase(u1), u1, f);
    mkEvidence(mkCase(u2), u2, f);

    const r = auditStorage(db);
    expect(rowFor(r, u1)!.file_bytes).toBe(100);
    expect(rowFor(r, u2)!.file_bytes).toBe(100);
    expect(r.totals.physical_bytes).toBe(100); // 盘上只有一份
    expect(r.totals.attributed_bytes).toBe(100);
    expect(r.totals.double_counted_bytes).toBe(100);
    expect(checkStorageIdentities(r)).toEqual([]);
  });

  test('删案级联删证据后，该用户不再背这些字节', () => {
    const uid = mkUser('a@t.com');
    const caseId = mkCase(uid);
    mkEvidence(caseId, uid, mkFile('aa', 100));
    expect(getUserStorage(db, uid).file_bytes).toBe(100);

    db.prepare('DELETE FROM cases WHERE id=?').run(caseId);

    expect(getUserStorage(db, uid)).toMatchObject({ file_bytes: 0, evidence_count: 0, file_count: 0 });
    // 字节没消失，只是变成了孤儿——由 GC 负责，不由用户背
    expect(auditStorage(db).totals.orphan_bytes).toBe(100);
  });
});

// ───────────────────────── 三个桶 ─────────────────────────

describe('总账三桶：有主 / 无主 / 孤儿', () => {
  /** 三桶各有内容的库：有主 100、无主 400（证据已删的出证证书）、孤儿 1000。 */
  function seedThreeBuckets() {
    const uid = mkUser('a@t.com');
    const caseId = mkCase(uid);
    const evFile = mkFile('aa', 100);
    const certFile = mkFile('cc', 400);
    mkFile('zz', 1000); // 无人引用 = 孤儿

    const evId = mkEvidence(caseId, uid, evFile);
    db.prepare('INSERT INTO attestations (order_no, sha256, evidence_id, cert_pdf_file_id) VALUES (?,?,?,?)')
      .run('att-1', 'cc', evId, certFile);
    // 证据被删 ⇒ attestations.evidence_id 置 NULL（ON DELETE SET NULL），证书从此无主
    db.prepare('DELETE FROM evidence WHERE id=?').run(evId);
    return { uid, caseId, evFile, certFile };
  }

  test('证据删后出证证书归入「无主」，既不算谁的也不当孤儿', () => {
    seedThreeBuckets();
    const t = auditStorage(db).totals;

    expect(t.unattributed_bytes).toBe(400);
    expect(t.unattributed_count).toBe(1);
    // 证书（400）仍被 attestations 引用，不落孤儿；而 evFile（100）的证据没了、无人引用，
    // 与本就没人引的 zz（1000）一起成为孤儿 ⇒ 1100。
    expect(t.orphan_bytes).toBe(1100);
    expect(t.attributed_bytes).toBe(0);
    expect(t.orphan_bytes + t.attributed_bytes + t.unattributed_bytes).toBe(t.physical_bytes);
    expect(t.physical_bytes).toBe(1500);
  });

  test('无主字节不被摊进任何用户', () => {
    const { uid } = seedThreeBuckets();
    expect(getUserStorage(db, uid).file_bytes).toBe(0);
    expect(auditStorage(db).users.every((u) => u.file_bytes === 0)).toBe(true);
  });

  test('孤儿口径与 filesGc 逐字节一致（两处判据必须同源）', () => {
    seedThreeBuckets();
    const t = auditStorage(db).totals;
    const orphans = findOrphanFiles(db);

    expect(t.orphan_count).toBe(orphans.length);
    expect(t.orphan_bytes).toBe(orphans.reduce((s, o) => s + o.size, 0));
  });

  test('空库：三桶全零且恒等式成立', () => {
    const r = auditStorage(db);
    expect(r.users).toEqual([]);
    expect(r.totals).toMatchObject({ physical_bytes: 0, attributed_bytes: 0, orphan_bytes: 0 });
    expect(checkStorageIdentities(r)).toEqual([]);
  });
});

// ───────────────────────── 自检本身有没有牙 ─────────────────────────

describe('checkStorageIdentities', () => {
  /** 造一份三桶齐全、用户多样的报告作为对照。 */
  function richReport(): StorageAuditReport {
    const u1 = mkUser('a@t.com');
    const u2 = mkUser('b@t.com');
    const c1 = mkCase(u1);
    const c2 = mkCase(u2);
    const shared = mkFile('sh', 64);
    mkEvidence(c1, u1, shared);
    mkEvidence(c2, u2, shared);
    mkEvidence(c1, u1, mkFile('own', 32));
    mkFile('orph', 8);
    const th = mkThread(c1);
    mkMessage(th, 'user', '仲裁');
    return auditStorage(db);
  }

  test('对照：真实报告恒等式成立', () => {
    expect(checkStorageIdentities(richReport())).toEqual([]);
  });

  test('物理字节被改坏 → 点名三桶对不上', () => {
    const r = richReport();
    const bad = { ...r, totals: { ...r.totals, physical_bytes: r.totals.physical_bytes + 1 } };
    const v = checkStorageIdentities(bad);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('物理字节对不上');
  });

  test('某用户字节被吞掉 → 点名重复计数对不上', () => {
    const r = richReport();
    const bad = { ...r, users: r.users.map((u, i) => (i === 0 ? { ...u, file_bytes: 0 } : u)) };
    const v = checkStorageIdentities(bad);
    expect(v.some((s) => s.includes('重复计数对不上'))).toBe(true);
  });

  test('有主文件没算进任何用户 → 重复计数为负，单独点名', () => {
    const r = richReport();
    const bad = {
      users: r.users.map((u) => ({ ...u, file_bytes: 0 })),
      totals: { ...r.totals, double_counted_bytes: -r.totals.attributed_bytes },
    };
    expect(checkStorageIdentities(bad).some((s) => s.includes('重复计数为负'))).toBe(true);
  });
});

// ───────────────────────── 结构守卫与单/全量一致 ─────────────────────────

describe('结构守卫', () => {
  test('归属路径清单与 filesGc 引用者清单逐条对齐', () => {
    // 日后给 files 加第四个外键时，只改一处就会在这里当场点名缺的是哪张表。
    expect([...OWNER_PATH_KEYS].sort()).toEqual([...REFERENCER_KEYS].sort());
    expect(REFERENCER_KEYS).toHaveLength(REFERENCERS.length);
  });

  test('单人查询与全量表给出同一行（口径不得分叉）', () => {
    const u1 = mkUser('a@t.com');
    const u2 = mkUser('b@t.com');
    const c1 = mkCase(u1);
    mkEvidence(c1, u1, mkFile('aa', 100));
    mkEvidence(mkCase(u2), u2, mkFile('bb', 200));
    mkMessage(mkThread(c1), 'user', '赔偿金怎么算');

    const all = auditStorage(db);
    for (const uid of [u1, u2]) {
      expect(getUserStorage(db, uid)).toEqual(rowFor(all, uid));
    }
  });

  test('无任何用量的用户拿到零行，而不是 undefined', () => {
    const uid = mkUser('idle@t.com');
    expect(getUserStorage(db, uid)).toEqual({
      user_id: uid,
      file_count: 0,
      file_bytes: 0,
      evidence_count: 0,
      message_count: 0,
      message_bytes: 0,
      total_bytes: 0,
    });
    expect(auditStorage(db).users).toEqual([]); // 全量表不列零用量用户
  });

  test('total_bytes = 文件 + 对话', () => {
    const uid = mkUser('a@t.com');
    const c = mkCase(uid);
    mkEvidence(c, uid, mkFile('aa', 100));
    mkMessage(mkThread(c), 'user', '仲裁'); // 6 字节
    const row = getUserStorage(db, uid);
    expect(row.total_bytes).toBe(row.file_bytes + row.message_bytes);
    expect(row.total_bytes).toBe(106);
  });
});

describe('humanBytes', () => {
  test('按 1024 进位，B 不带小数', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(999)).toBe('999 B');
    expect(humanBytes(1024)).toBe('1.0 KiB');
    expect(humanBytes(1536)).toBe('1.5 KiB');
    expect(humanBytes(1024 ** 3)).toBe('1.0 GiB');
  });
});

describe('storageAuditCli', () => {
  test('只读跑通、退出码 0，且不写任何行', () => {
    const uid = mkUser('a@t.com');
    const c = mkCase(uid);
    mkEvidence(c, uid, mkFile('aa', 100));
    mkMessage(mkThread(c), 'user', '解除通知书');

    const tmp = path.join(os.tmpdir(), `storage-audit-${process.pid}-${Date.now()}.db`);
    const disk = new Database(tmp);
    disk.pragma('foreign_keys = ON');
    runMigrations(disk);
    const u = Number(disk.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
    const cid = Number(disk.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(u, '案').lastInsertRowid);
    const fid = Number(
      disk.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)').run('aa', 100, 'aa.enc').lastInsertRowid,
    );
    disk.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)').run(cid, u, fid, '证据');
    const before = disk.prepare('SELECT COUNT(*) n FROM files').get() as { n: number };
    disk.close();

    expect(storageAuditCli(tmp)).toBe(0);

    const after = new Database(tmp, { readonly: true });
    expect(after.prepare('SELECT COUNT(*) n FROM files').get()).toEqual(before);
    after.close();
    fs.unlinkSync(tmp);
  });
});
