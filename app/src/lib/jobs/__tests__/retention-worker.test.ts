// app/src/lib/jobs/__tests__/retention-worker.test.ts
// 保留期清理任务。要害五条：
//   ① **时钟注入**：不把时间拨到保留期之后，这个任务只能靠等 30 天来验——那等于没有判据；
//   ② 边界：差一天不删、到点才删（30 日是对外承诺的那个数，不是「差不多一个月」）；
//   ③ 硬删是级联的：证据条目、对话、情绪与危机记录、时间线、文书一起没；
//   ④ **已出证的存证记录仍可读**：它脱离案件继续存在，公开核验那条路不受影响；
//   ⑤ 密文文件被回收，且回收判据仍是「无人引用」——别的案件还引着的那一份不许删；
//   ⑥ **这个账号导出过整案副本**时上面五条照旧成立。这条是复审 blocker 的回归位：
//      导出会签一条下载令牌，那张表是 files 的外键引用者，签过之后这一轮清理的形态
//      完全不同（要么整轮回滚、要么那份装着全部原件的 zip 永远留在盘上）。
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
import { exportCase } from '@/lib/lifecycle/case-export';
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


// ───────────────────────── 导出过整案副本之后 ─────────────────────────
//
// 【为什么单独一组】上面每一组跑的都是一个从没导出过的账号，而**导出是免费的、页面上就一个
// 按钮**：真实的库里从第一次导出起就有 file_download_tokens 行。那张表引着 files，
// 于是这一轮清理面对的是完全不同的一张图。复审（2026-09-07）在这里抓到 blocker：
// 引用者清单漏了这张表，整段事务撞外键回滚，密文一份都回收不掉。
describe('导出过整案副本之后', () => {
  const renderPdf = async () => Buffer.from('%PDF-1.4 假导出件\n%%EOF');

  /** 走真导出（会落一份 zip 到 files、签一条下载令牌），返回那份 zip 的 file_id。 */
  async function exportOnce(now: Date): Promise<number> {
    const res = await exportCase({ db, caseId, userId: uid, renderPdf, now });
    if (!res.ok) throw new Error(`导出失败：${res.message}`);
    return (db.prepare('SELECT id FROM files WHERE sha256=?').get(res.sha256) as { id: number }).id;
  }

  it('清理整轮不出错，到期案件与它的原件照样被删（变异：REFERENCERS 去掉 file_download_tokens → 本条红）', async () => {
    const { fileId } = seedAndAttest();
    await exportOnce(new Date('2026-08-31T00:00:00Z'));
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    const res = runRetentionOnce(db, opts(DUE));

    // ① 整轮没炸：漏认引用者时这里是 ok=0 + FOREIGN KEY constraint failed
    const run = lastRun(db, RETENTION_JOB_NAME);
    expect(run!.error_text, '整轮报错了').toBeNull();
    expect(run!.ok).toBe(1);
    // ② 案件与证据原件真的被清掉了（回滚的形态下 files_removed=0、证据密文还在）
    expect(res.cases_purged).toBe(1);
    expect(res.files_removed).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', fileId)).toBe(0);
    // ③ 没有留下「盘上已删、库行还在」的坏行：删过盘的每一条都不在库里了
    for (const p of removedPaths) {
      expect(count('SELECT COUNT(*) AS n FROM files WHERE enc_path=?', p), `坏行：${p}`).toBe(0);
    }
  });

  it('导出件本身也被回收：过期的下载令牌先删，那份 zip 随即成为孤儿（变异：删掉 purgeExpiredFileTokens 那一句 → 本条红）', async () => {
    seedAndAttest();
    const zipFileId = await exportOnce(new Date('2026-08-31T00:00:00Z'));
    db.prepare('UPDATE cases SET deleted_at=? WHERE id=?').run(DELETED_AT, caseId);

    const res = runRetentionOnce(db, opts(DUE));

    expect(res.tokens_purged).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM file_download_tokens')).toBe(0);
    // 那份 zip 装着这个案子的全部证据原件；它留在盘上，五.8 的三十日承诺就是假的
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', zipFileId), '导出件没被回收').toBe(0);
  });

  /**
   * 刚过期的那一行**不删**：两张令牌表把 not_found / expired / consumed 分三档回话，
   * 行一删这三档就塌成一档，用户在过期后重试的那几分钟里收到的是"这条地址不存在"，
   * 而那条地址是我们十分钟前发给他的。宽限期见 lib/db/lifecycle.DEAD_TOKEN_GRACE_HOURS。
   *
   * 变异：把 purgeExpiredFileTokens 的宽限期去掉（改成 expires_at <= now）→ 本条红。
   */
  it('过期不满一天的令牌行留着（「已过期」这句话要说得出来），满一天才删', async () => {
    seedAndAttest();
    // 到点前 2 小时导出：跑清理时它已经过期（10 分钟有效期），但死了还不到一天
    const zipFileId = await exportOnce(new Date('2026-09-30T22:00:00Z'));

    expect(runRetentionOnce(db, opts(DUE)).tokens_purged).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM file_download_tokens')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', zipFileId)).toBe(1);

    // 再过一天：这一行死透了，跟着那份 zip 一起收掉
    const nextDay = new Date('2026-10-02T00:00:00Z');
    expect(runRetentionOnce(db, opts(nextDay)).tokens_purged).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', zipFileId)).toBe(0);
  });

  /**
   * 【这一条才是 REFERENCERS 那份清单的判据位】上面两条走的是"令牌已过期"这条路，
   * 而过期令牌在回收之前就被删掉了，于是清单漏没漏它都看不出来。**活着的令牌才看得出来**：
   * 清单漏了它，那份 zip 会被当成孤儿去删，DELETE 撞外键 → 整轮回滚 → 同一轮里
   * 本该收掉的真孤儿一个也收不掉，而回包上只表现为 files_removed=0。
   *
   * 变异：REFERENCERS 去掉 file_download_tokens → 本条红（真孤儿没被收、job_runs ok=0）。
   */
  it('还没过期的下载令牌一行都不动，它引着的文件不许删，同一轮的真孤儿照收', async () => {
    seedAndAttest();
    // 到点前 5 分钟才导出：令牌 10 分钟有效期，跑清理时它还活着
    const zipFileId = await exportOnce(new Date('2026-09-30T23:55:00Z'));
    // 同一轮里摆一个货真价实的孤儿：整轮回滚的话它会跟着幸存下来
    const realOrphan = Number(
      db
        .prepare("INSERT INTO files (sha256, size, enc_path) VALUES ('0000orphan', 7, '00/orphan.enc')")
        .run().lastInsertRowid,
    );

    const res = runRetentionOnce(db, opts(DUE));

    // ① 活着的令牌与它引着的导出件都在
    expect(res.tokens_purged).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM file_download_tokens')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', zipFileId), '把还能下载的导出件删了').toBe(1);
    // ② 整轮没被一次外键冲突带走：真孤儿收掉了，留痕也是 ok
    expect(res.files_removed).toBe(1);
    expect(removedPaths).toEqual(['00/orphan.enc']);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', realOrphan)).toBe(0);
    const run = lastRun(db, RETENTION_JOB_NAME);
    expect(run!.error_text).toBeNull();
    expect(run!.ok).toBe(1);
  });
});
