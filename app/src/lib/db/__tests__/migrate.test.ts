import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';

/** 全部表名单（29 张）。新增表必须同步本列表——漏改即测试失败，防迁移文件与预期悄悄分叉。 */
const ALL_TABLES = [
  // 用户与实名
  'users', 'sms_codes', 'email_codes', 'realname_verifications', 'api_keys',
  // 案件档案
  'cases', 'company_profiles', 'timeline_events', 'files', 'evidence', 'attestations',
  'company_docs', 'claims', 'action_items', 'deadlines', 'threads', 'messages',
  'emotion_log', 'share_links', 'drafts',
  // 公道值
  'gongdao', 'gongdao_ledger', 'memberships', 'skus', 'orders', 'redemption_codes',
  'token_usage', 'model_rates',
  // 通知
  'notify_log',
];

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** 建一个用户，返回 id。 */
function mkUser(db: Database.Database, phoneHash: string | null = null): number {
  return Number(
    db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run(phoneHash).lastInsertRowid,
  );
}

/** 建一个案件，返回 id。 */
function mkCase(db: Database.Database, userId: number): number {
  return Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '测试案件')
      .lastInsertRowid,
  );
}

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newDb();
  });

  it('幂等：连跑两遍不抛错', () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(ALL_TABLES.length).toBe(29);
  });

  it('29 张表全部建成', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const got = new Set(rows.map((r) => r.name));
    for (const t of ALL_TABLES) expect(got.has(t), `缺表 ${t}`).toBe(true);
    expect(got.size).toBe(ALL_TABLES.length);
  });

  it('foreign_keys=ON 生效：悬空 case_id 被拒', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO claims (case_id, kind) VALUES (99999, '2N')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('唯一约束（用实际写入冲突验证）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newDb();
  });

  it('gongdao_ledger：同 (type, ref_id) 二次写入被幂等索引挡下，ref_id 为 NULL 时允许多行', () => {
    const uid = mkUser(db);
    const ins = db.prepare(
      'INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?,?,?)',
    );
    expect(ins.run(uid, 100, '充值', 'order-1').changes).toBe(1);
    expect(ins.run(uid, 100, '充值', 'order-1').changes).toBe(0);
    // 同 ref_id 但不同 type 不算重复
    expect(ins.run(uid, -100, '退款', 'order-1').changes).toBe(1);
    // ref_id 为 NULL 的行不参与去重
    expect(ins.run(uid, -1, '消耗', null).changes).toBe(1);
    expect(ins.run(uid, -1, '消耗', null).changes).toBe(1);
  });

  it('users.phone_hash：重复被拒，多个 NULL 允许', () => {
    mkUser(db, 'hash-a');
    expect(() => mkUser(db, 'hash-a')).toThrow(/UNIQUE/);
    expect(() => {
      mkUser(db, null);
      mkUser(db, null);
    }).not.toThrow();
  });

  it('users.email：重复被拒，多个 NULL 允许', () => {
    const ins = db.prepare('INSERT INTO users (email) VALUES (?)');
    ins.run('a@example.com');
    expect(() => ins.run('a@example.com')).toThrow(/UNIQUE/);
    expect(() => {
      ins.run(null);
      ins.run(null);
    }).not.toThrow();
  });

  it('files.sha256：重复被拒', () => {
    const ins = db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)');
    ins.run('sha-1', 10, '/enc/1');
    expect(() => ins.run('sha-1', 10, '/enc/2')).toThrow(/UNIQUE/);
  });

  it('attestations.order_no：重复被拒', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const fileId = Number(
      db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
        .run('sha-att', 10, '/enc/att').lastInsertRowid,
    );
    const evId = Number(
      db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
        .run(caseId, uid, fileId, '劳动合同').lastInsertRowid,
    );
    const ins = db.prepare(
      'INSERT INTO attestations (evidence_id, order_no, sha256) VALUES (?,?,?)',
    );
    ins.run(evId, 'att-1', 'sha-att');
    expect(() => ins.run(evId, 'att-1', 'sha-att')).toThrow(/UNIQUE/);
  });

  it('notify_log：同 (scene,biz_key,channel) 两条 sent 被拒；failed 后再 sent 允许', () => {
    const ins = db.prepare(
      'INSERT INTO notify_log (scene, biz_key, channel, status, detail) VALUES (?,?,?,?,?)',
    );
    ins.run('deadline', 'case-1-d7', 'sms', 'sent', null);
    expect(() => ins.run('deadline', 'case-1-d7', 'sms', 'sent', null)).toThrow(/UNIQUE/);
    // 另一通道各自独立判定：短信成功不掩盖邮件失败，邮件重试直至成功
    expect(() => {
      ins.run('deadline', 'case-1-d7', 'email', 'failed', 'SMTP 550 mailbox unavailable');
      ins.run('deadline', 'case-1-d7', 'email', 'failed', 'SMTP 421 too many connections');
      ins.run('deadline', 'case-1-d7', 'email', 'sent', null);
    }).not.toThrow();
  });

  it('model_rates.token_kind：CHECK 约束只放行 in/out/cache', () => {
    const ins = db.prepare(
      'INSERT INTO model_rates (model, token_kind, gongdao_per_token) VALUES (?,?,?)',
    );
    ins.run('claude-opus-5', 'in', 0.003);
    expect(() => ins.run('claude-opus-5', 'embed', 0.001)).toThrow(/CHECK/);
  });
});

describe('删除行为', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newDb();
  });

  it('删案件级联删子表，但已出证据存证与文件不随之消失', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const fileId = Number(
      db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
        .run('sha-c', 10, '/enc/c').lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?,?,?,?)",
    ).run(caseId, '2026-08-01', '公司动作', '口头通知裁员');
    db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, '录音');
    db.prepare("INSERT INTO claims (case_id, kind, amount_fen) VALUES (?,?,?)")
      .run(caseId, '2N', 12345600);
    db.prepare("INSERT INTO deadlines (case_id, kind, due_at) VALUES (?,?,?)")
      .run(caseId, '仲裁时效', '2027-08-01');
    const threadId = Number(
      db.prepare("INSERT INTO threads (case_id, mode) VALUES (?,?)")
        .run(caseId, '问诊').lastInsertRowid,
    );
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?,?,?)")
      .run(threadId, 'user', '公司让我签自愿离职');

    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    for (const t of ['timeline_events', 'evidence', 'claims', 'deadlines', 'threads']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
    // threads 级联 → messages 二级级联
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0);
    // files 不属于案件子表，删案不动它
    expect((db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(1);
  });

  it('users 无级联：删还有案件的用户被外键挡下', () => {
    const uid = mkUser(db);
    mkCase(db, uid);
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(uid)).toThrow(/FOREIGN KEY/);
  });
});
