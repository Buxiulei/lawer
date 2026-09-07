// app/src/lib/jobs/__tests__/retention-worker.test.ts
// 保留期清理任务。要害五条：
//   ① **时钟注入**：不把时间拨到保留期之后，这个任务只能靠等 30 天来验——那等于没有判据；
//   ② 边界：差一天不删、到点才删（30 日是对外承诺的那个数，不是「差不多一个月」）；
//   ③ 硬删是级联的：证据条目、对话、情绪与危机记录、时间线、文书一起没；
//   ④ **已出证的存证记录仍可读**：它脱离案件继续存在，公开核验那条路不受影响；
//   ⑤ 密文文件被回收，且回收判据仍是「无人引用」——别的案件还引着的那一份不许删。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
process.env.FILES_DIR = FILES_DIR;

import { lastRun } from '@/lib/db/job-runs';
import { runMigrations } from '@/lib/db/migrate';
import { storeBytes } from '@/lib/evidence/files';
import { RETENTION_DAYS } from '@/lib/lifecycle/retention';

import { RETENTION_JOB_NAME, runRetentionOnce } from '../retention-worker';

const DELETED_AT = '2026-09-01 00:00:00';
/** 保留期最后一天的那一刻：**还不该删**。 */
const ONE_DAY_EARLY = new Date('2026-09-30T23:59:59Z');
/** 刚好到点。 */
const DUE = new Date('2026-10-01T00:00:00Z');

let db: Database.Database;
let uid: number;
let caseId: number;
let removedPaths: string[];

beforeAll(() => {
  expect(RETENTION_DAYS, '保留期不是 30 天了，本文件的两个时刻要跟着改').toBe(30);
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  removedPaths = [];
  uid = Number(db.prepare("INSERT INTO users (email) VALUES ('a@t.com')").run().lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '甲的档案').lastInsertRowid,
  );
});

const opts = (now: Date) => ({
  now: () => now,
  deleteFromDisk: (p: string) => {
    removedPaths.push(p);
  },
});

/** 建一份带证据、对话、情绪、危机、时间线、文书的案子，并给证据出一张存证证明。 */
function seedAndAttest(): { evidenceId: number; orderNo: string; fileId: number } {
  const { fileId } = storeBytes(db, Buffer.from(`原件-${crypto.randomUUID()}`), 'text/plain');
  const evidenceId = Number(
    db
      .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, '工资条.txt').lastInsertRowid,
  );
  const threadId = Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '陪跑')").run(caseId).lastInsertRowid,
  );
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', '我该怎么办')").run(threadId);
  db.prepare("INSERT INTO emotion_log (case_id, level) VALUES (?, '焦虑')").run(caseId);
  db.prepare("INSERT INTO crisis_hits (case_id, user_id, source, terms_hash) VALUES (?,?,'site','h')").run(
    caseId,
    uid,
  );
  db.prepare(
    "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, '2026-08-01 00:00:00', '公司动作', '约谈')",
  ).run(caseId);
  db.prepare("INSERT INTO drafts (case_id, kind, title) VALUES (?, '异议函', '稿')").run(caseId);
  db.prepare("INSERT INTO claims (case_id, kind, amount_fen) VALUES (?, '欠薪', 100)").run(caseId);
  db.prepare("INSERT INTO share_links (case_id, token, expires_at) VALUES (?, 'tok', '2030-01-01 00:00:00')").run(
    caseId,
  );

  const orderNo = 'ATT-0001';
  // 证明 PDF 自己也是一份 files 行：它**不该**被回收（attestations 仍引着它）
  const cert = storeBytes(db, Buffer.from('假的存证证明 PDF'), 'application/pdf');
  db.prepare(
    `INSERT INTO attestations (evidence_id, order_no, sha256, cert_pdf_file_id, status)
     VALUES (?,?,?,?, 'done')`,
  ).run(evidenceId, orderNo, 'a'.repeat(64), cert.fileId);
  return { evidenceId, orderNo, fileId };
}

const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe('时钟与边界', () => {
  it('还没到期的一行都不动（变异：把 cutoff 算成 now → 本条红）', () => {
    seedAndAttest();
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    const res = runRetentionOnce(db, opts(ONE_DAY_EARLY));
    expect(res.cases_purged).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM cases WHERE id=?', caseId)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM evidence')).toBe(1);
  });

  it('从没被标删的案子永远不动（软删标记是唯一入口）', () => {
    seedAndAttest();
    const res = runRetentionOnce(db, opts(new Date('2030-01-01T00:00:00Z')));
    expect(res.cases_purged).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM cases WHERE id=?', caseId)).toBe(1);
  });

  it('到点即删，且档案的全部子表一起没（变异：把某张子表的 CASCADE 去掉 → 本条红）', () => {
    seedAndAttest();
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    const res = runRetentionOnce(db, opts(DUE));
    expect(res.cases_purged).toBe(1);
    for (const t of [
      'cases',
      'evidence',
      'threads',
      'messages',
      'emotion_log',
      'crisis_hits',
      'timeline_events',
      'drafts',
      'claims',
      'share_links',
    ]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t}`), `${t} 没被删干净`).toBe(0);
    }
  });
});

describe('硬删之后仍然留下的东西', () => {
  it('存证记录仍可读：订单号、哈希、证明 PDF 都在（变异：把 attestations.evidence_id 改成 CASCADE → 本条红）', () => {
    const { orderNo } = seedAndAttest();
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    runRetentionOnce(db, opts(DUE));

    const att = db
      .prepare('SELECT evidence_id, order_no, sha256, cert_pdf_file_id, status FROM attestations WHERE order_no=?')
      .get(orderNo) as Record<string, unknown>;
    expect(att, '已出具的存证证明被案件删除带走了').toBeDefined();
    expect(att.evidence_id, '断链之后应为 NULL，而不是指向一个不存在的条目').toBeNull();
    expect(att.order_no).toBe(orderNo);
    expect(att.sha256).toBe('a'.repeat(64));
    // 证明 PDF 那份文件还被引着，所以不该被回收
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', att.cert_pdf_file_id)).toBe(1);
  });

  it('「我不需要心理咨询」这类拒绝记录比案件活得久', () => {
    db.prepare(
      "INSERT INTO referral_offers (user_id, case_id, scene, outcome) VALUES (?,?,'情绪场景','declined')",
    ).run(uid, caseId);
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    runRetentionOnce(db, opts(DUE));

    const row = db.prepare('SELECT case_id, outcome FROM referral_offers WHERE user_id=?').get(uid);
    expect(row).toEqual({ case_id: null, outcome: 'declined' });
  });
});

describe('密文文件回收', () => {
  it('无人引用的原件被删掉、盘上文件也删了（变异：把 gcOrphanFiles 那一段删掉 → 本条红）', () => {
    const { fileId } = seedAndAttest();
    const encPath = (db.prepare('SELECT enc_path FROM files WHERE id=?').get(fileId) as { enc_path: string })
      .enc_path;
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    const res = runRetentionOnce(db, opts(DUE));
    expect(res.files_removed).toBe(1);
    expect(res.freed_bytes).toBeGreaterThan(0);
    expect(removedPaths).toEqual([encPath]);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', fileId)).toBe(0);
  });

  it('还被别的案件引着的同一份文件不许删（回收判据仍是「无人引用」）', () => {
    const { fileId } = seedAndAttest();
    const otherCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '另一个案子').lastInsertRowid,
    );
    db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)').run(
      otherCase,
      uid,
      fileId,
      '同一份原件',
    );
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    runRetentionOnce(db, opts(DUE));
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', fileId), '把别人还在用的原件删了').toBe(1);
    expect(removedPaths).toEqual([]);
  });
});

describe('注销账号的最终清理', () => {
  it('到期后抹掉可识别字段并盖 purged_at（变异：claimUserPurge 去掉 purged_at IS NULL → 下一条红）', () => {
    db.prepare("UPDATE users SET cancelled_at=?, email='a@t.com' WHERE id=?").run(DELETED_AT, uid);
    const res = runRetentionOnce(db, opts(DUE));
    expect(res.users_purged).toBe(1);
    const row = db.prepare('SELECT email, purged_at FROM users WHERE id=?').get(uid) as {
      email: string | null;
      purged_at: string | null;
    };
    expect(row.email).toBeNull();
    expect(row.purged_at).toBe('2026-10-01 00:00:00');
  });

  it('再跑一轮不重复计数（purged_at 既是完成标记也是抢占位）', () => {
    db.prepare('UPDATE users SET cancelled_at=? WHERE id=?').run(DELETED_AT, uid);
    expect(runRetentionOnce(db, opts(DUE)).users_purged).toBe(1);
    expect(runRetentionOnce(db, opts(DUE)).users_purged).toBe(0);
  });

  it('还没到期的注销账号不动', () => {
    db.prepare('UPDATE users SET cancelled_at=? WHERE id=?').run(DELETED_AT, uid);
    expect(runRetentionOnce(db, opts(ONE_DAY_EARLY)).users_purged).toBe(0);
    expect(
      (db.prepare('SELECT purged_at FROM users WHERE id=?').get(uid) as { purged_at: string | null }).purged_at,
    ).toBeNull();
  });
});

describe('幂等与留痕', () => {
  it('同一轮跑两次，第二次一件都没得做（删除本身就是抢占：changes===1 才算数）', () => {
    seedAndAttest();
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);
    expect(runRetentionOnce(db, opts(DUE)).cases_purged).toBe(1);
    const second = runRetentionOnce(db, opts(DUE));
    expect(second.cases_purged).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('每一轮都往 job_runs 落一行——「今天有没有跑过」只有那张表答得上来', () => {
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);
    runRetentionOnce(db, opts(DUE));
    const run = lastRun(db, RETENTION_JOB_NAME);
    expect(run, '没落 job_runs：任务没起来这件事从外面一个字都看不出来').toBeDefined();
    expect(run!.ok).toBe(1);
    expect(run!.finished_at).not.toBeNull();
    expect(run!.items_ok).toBe(1);
    expect(run!.note).toContain('到期删除');
  });

  it('recordRun:false 时不落 job_runs（判据自己跑一轮不该污染留痕表）', () => {
    runRetentionOnce(db, { ...opts(DUE), recordRun: false });
    expect(lastRun(db, RETENTION_JOB_NAME)).toBeUndefined();
  });

  it('整轮炸了也要回填 job_runs 的 ok=0 与原文（不留一行永远「未跑完」）', () => {
    seedAndAttest();
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);
    const res = runRetentionOnce(db, {
      ...opts(DUE),
      deleteFromDisk: () => {
        throw new Error('盘挂了');
      },
    });
    // 案件那一步已经做完了，炸在回收那一步
    expect(res.cases_purged).toBe(1);
    const run = lastRun(db, RETENTION_JOB_NAME);
    expect(run!.ok).toBe(0);
    expect(run!.error_text).toContain('盘挂了');
    expect(run!.finished_at).not.toBeNull();
  });
});
