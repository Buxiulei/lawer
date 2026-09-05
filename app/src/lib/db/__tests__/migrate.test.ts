import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';

/**
 * 全部表名单（53 张）。新增表必须同步本列表——漏改即测试失败，防迁移文件与预期悄悄分叉。
 *
 * 【张数怎么来的】不照抄任何一支的自报数：48 = 实跑 runMigrations 之后数 sqlite_master 里的用户表。
 * 合并时两支分别报过 47 与 42，两个数在各自基线上都对，加起来却不是并集——
 * 三张表（pricing_config / entitlements / company_dossiers）两支都建，去重后才是真值。
 */
const ALL_TABLES = [
  // 用户与实名
  'users', 'sms_codes', 'email_codes', 'ip_quota_events', 'otp_send_attempts',
  'realname_verifications', 'api_keys',
  // 案件档案
  'cases', 'company_profiles', 'timeline_events', 'files', 'evidence', 'attestations',
  'company_docs', 'contract_reviews', 'review_findings', 'claims', 'action_items',
  'deadlines', 'threads', 'messages', 'emotion_log', 'referral_offers', 'share_links', 'drafts',
  // agent 写入台账（幂等 + 审计）
  'agent_writes',
  // 公道值
  'gongdao', 'gongdao_ledger', 'memberships', 'skus', 'orders', 'redemption_codes',
  'token_usage', 'model_rates',
  // 公司档案（模块化报价与计费）
  'pricing_config', 'entitlements', 'company_dossiers',
  // 公司动态监控
  'company_watches', 'company_watch_events', 'company_watch_checks',
  'company_relations', 'company_litigation',
  // 公司档案（背调产品化）—— pricing_config / entitlements / company_dossiers 已在上面
  // 「模块化报价与计费」那一组里列过（两支都建同名表，migrate.ts 里已合成唯一定义），此处不重复。
  'company_dossier_blocks', 'company_dossier_stats', 'company_patterns',
  // 免费前置探测（§2.3）
  'company_probe_cache', 'company_probe_events',
  // 通知
  'notify_log',
  // 任务运行
  'job_runs',
  // 管理后台审计
  'admin_audit',
  // 服务报价与内容提取任务
  'service_quotes', 'extraction_jobs',
  // 一次性上传地址
  'evidence_upload_tokens',
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

/** 建一个公司背调档，返回 id。 */
function mkProfile(db: Database.Database, caseId: number, name: string): number {
  return Number(
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?,?)').run(caseId, name)
      .lastInsertRowid,
  );
}

/** 建一条「被审文件 → 审查记录 → 一条发现」的完整链，返回三级 id。 */
function mkReview(
  db: Database.Database,
  caseId: number,
  uid: number,
): { docId: number; reviewId: number; findingId: number } {
  const fileId = Number(
    db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
      .run(`sha-review-${uid}-${caseId}`, 10, '/enc/review').lastInsertRowid,
  );
  const docId = Number(
    db.prepare("INSERT INTO company_docs (case_id, file_id, doc_type) VALUES (?,?,'其他')")
      .run(caseId, fileId).lastInsertRowid,
  );
  const reviewId = Number(
    db.prepare('INSERT INTO contract_reviews (company_doc_id, case_id, contract_type) VALUES (?,?,?)')
      .run(docId, caseId, '劳动合同').lastInsertRowid,
  );
  const findingId = Number(
    db.prepare('INSERT INTO review_findings (review_id, clause_ref, severity, issue) VALUES (?,?,?,?)')
      .run(reviewId, '第三条', 'must', '试用期超法定上限').lastInsertRowid,
  );
  return { docId, reviewId, findingId };
}

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newDb();
  });

  it('幂等：连跑两遍不抛错', () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(ALL_TABLES.length).toBe(53);
  });

  it('53 张表全部建成', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const got = new Set(rows.map((r) => r.name));
    // 先查名单自身没有重名：两支各自往名单尾巴上追加同一张表时，下面那条数量断言只会报
    // 「47 不等于 50」，不会说是哪张表重了——这条把重复的表名直接点出来。
    const dup = ALL_TABLES.filter((t, i) => ALL_TABLES.indexOf(t) !== i);
    expect(dup, `ALL_TABLES 里有重复表名：${dup.join(', ')}`).toEqual([]);
    for (const t of ALL_TABLES) expect(got.has(t), `缺表 ${t}`).toBe(true);
    expect(got.size).toBe(ALL_TABLES.length);
  });

  /**
   * 提取相关的加法迁移**可重入**：evidence 补的八列在第二遍不重复加（SQLite 的
   * ADD COLUMN 没有 IF NOT EXISTS，裸写第二遍就 duplicate column name ⇒ 应用起不来），
   * 且第二遍不碰已有数据——「重跑一次迁移把用户已提取的文本抹回 NULL」是这类迁移
   * 最坏的失败形态：库能起来、页面正常、内容没了。
   */
  it('evidence 提取八列：连跑两遍不抛错，且不改已写入的值', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const fileId = Number(
      db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
        .run('e'.repeat(64), 10, 'ee/e.enc').lastInsertRowid,
    );
    const evId = Number(
      db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
        .run(caseId, uid, fileId, '解除通知.jpg').lastInsertRowid,
    );
    // 新行取 DDL 默认：从没排过队 = none，简报版本 0（不是 1，见 migrate.ts 注释）
    expect(
      db.prepare('SELECT extraction_status, brief_version, extracted_text FROM evidence WHERE id=?').get(evId),
    ).toEqual({ extraction_status: 'none', brief_version: 0, extracted_text: null });

    db.prepare("UPDATE evidence SET extraction_status='done', extracted_text=? WHERE id=?")
      .run('甲方决定与乙方解除劳动关系', evId);

    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db.prepare('SELECT extraction_status, extracted_text FROM evidence WHERE id=?').get(evId),
    ).toEqual({ extraction_status: 'done', extracted_text: '甲方决定与乙方解除劳动关系' });
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

  // 这条索引就是「买会员送核心四项」的**幂等键**：grantEntitlement 走 INSERT OR IGNORE，
  // 全靠它把支付回调重放挡成 changes=0。索引没建 / 建成非部分索引，两种错法都不会报错，
  // 只会让重放多送一张券——白送一次查不出来，所以在这里用真实写入冲突验一遍。
  it('entitlements：同 (kind, source_ref) 二次发券被挡下；source_ref 为 NULL 时允许多行', () => {
    const uid = mkUser(db);
    const ins = db.prepare(
      'INSERT OR IGNORE INTO entitlements (user_id, kind, source_ref) VALUES (?,?,?)',
    );
    expect(ins.run(uid, 'dossier_core', 'ORD-1').changes).toBe(1);
    expect(ins.run(uid, 'dossier_core', 'ORD-1').changes).toBe(0);
    // 换个 kind 不算重复（将来多一种券时，两种券各自独立发放）
    expect(ins.run(uid, 'other_kind', 'ORD-1').changes).toBe(1);
    // 手工发放（无来源）不参与幂等：NULL 互不相等，部分索引也不盖它们
    expect(ins.run(uid, 'dossier_core', null).changes).toBe(1);
    expect(ins.run(uid, 'dossier_core', null).changes).toBe(1);
  });

  it('company_dossiers.company_key：重复被拒（同一家公司全站一条，不是每人一条）', () => {
    const ins = db.prepare('INSERT INTO company_dossiers (company_key, name) VALUES (?,?)');
    ins.run('北京甲科技有限公司', '北京甲科技有限公司');
    expect(() => ins.run('北京甲科技有限公司', '北京甲科技有限公司')).toThrow(/UNIQUE/);
  });

  it('pricing_config.key：主键去重，INSERT OR REPLACE 改价只留一行', () => {
    const ins = db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)');
    ins.run('dossier.graph', 200);
    ins.run('dossier.graph', 180);
    expect(db.prepare('SELECT value_int FROM pricing_config WHERE key=?').get('dossier.graph')).toEqual({
      value_int: 180,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pricing_config').get()).toEqual({ n: 1 });
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

  it('model_rates.token_kind：CHECK 约束只放行 in/out/cache_read/cache_write', () => {
    const ins = db.prepare(
      'INSERT INTO model_rates (model, token_kind, gongdao_per_token) VALUES (?,?,?)',
    );
    for (const kind of ['in', 'out', 'cache_read', 'cache_write']) {
      expect(() => ins.run('claude-opus-5', kind, 0.003), `${kind} 应被放行`).not.toThrow();
    }
    expect(() => ins.run('claude-opus-5', 'embed', 0.001)).toThrow(/CHECK/);
    // 旧的合并档 cache 已作废（缓存读 0.1× 与缓存写 1.25× 不可同价）
    expect(() => ins.run('claude-opus-5', 'cache', 0.001)).toThrow(/CHECK/);
  });

  it('company_litigation：同 (profile, case_no) 二次 INSERT OR IGNORE 落空，不同主体同案号各留一行', () => {
    const caseId = mkCase(db, mkUser(db));
    const p1 = mkProfile(db, caseId, '某某科技有限公司');
    const p2 = mkProfile(db, caseId, '某某科技（北京）分公司');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO company_litigation (company_profile_id, case_no, is_labor) VALUES (?,?,?)',
    );
    expect(ins.run(p1, '(2025)京0105民初12345号', 1).changes).toBe(1);
    // 同一判决被反复抓取（每日轮询、多源交叉）只落一行
    expect(ins.run(p1, '(2025)京0105民初12345号', 1).changes).toBe(0);
    // 同一案号在另一被监控主体名下是另一条记录（母公司与分公司同列被告）
    expect(ins.run(p2, '(2025)京0105民初12345号', 1).changes).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM company_litigation').get() as { c: number }).c).toBe(2);
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
    const evId = Number(
      db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
        .run(caseId, uid, fileId, '录音').lastInsertRowid,
    );
    // 该证据已出证：删案不得被存证外键挡下，存证行留存、断链置 NULL
    db.prepare('INSERT INTO attestations (evidence_id, order_no, sha256) VALUES (?,?,?)')
      .run(evId, 'att-cascade', 'sha-c');
    db.prepare("INSERT INTO claims (case_id, kind, amount_fen) VALUES (?,?,?)")
      .run(caseId, '2N', 12345600);
    db.prepare("INSERT INTO deadlines (case_id, kind, due_at) VALUES (?,?,?)")
      .run(caseId, '仲裁时效', '2027-08-01');
    const threadId = Number(
      db.prepare("INSERT INTO threads (case_id, mode) VALUES (?,?)")
        .run(caseId, '问诊').lastInsertRowid,
    );
    const msgId = Number(
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?,?,?)")
        .run(threadId, 'user', '公司让我签自愿离职').lastInsertRowid,
    );
    // 待办回指消息：删案时 messages 与 action_items 两路级联顺序不保证，SET NULL 免级联顺序陷阱
    db.prepare('INSERT INTO action_items (case_id, title, source_message_id) VALUES (?,?,?)')
      .run(caseId, '不要签字，先要书面通知', msgId);

    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    for (const t of ['timeline_events', 'evidence', 'claims', 'deadlines', 'threads', 'action_items']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
    // threads 级联 → messages 二级级联
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0);
    // files 不属于案件子表，删案不动它
    expect((db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(1);
    // 存证留存且断链置 NULL（自含记录，/verify 校验不受影响）
    const att = db.prepare('SELECT evidence_id, sha256 FROM attestations WHERE order_no=?')
      .get('att-cascade') as { evidence_id: number | null; sha256: string };
    expect(att.evidence_id).toBeNull();
    expect(att.sha256).toBe('sha-c');
  });

  it('deadlines.resolved_at 与 users.notify_verbose：新列默认值语义', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    db.prepare("INSERT INTO deadlines (case_id, kind, due_at) VALUES (?,?,?)")
      .run(caseId, '起诉15日', '2026-09-01');
    // 默认生效中（resolved_at NULL）；置时间戳即退出提醒
    expect(
      (db.prepare('SELECT COUNT(*) c FROM deadlines WHERE resolved_at IS NULL').get() as { c: number }).c,
    ).toBe(1);
    db.prepare("UPDATE deadlines SET resolved_at = datetime('now')").run();
    expect(
      (db.prepare('SELECT COUNT(*) c FROM deadlines WHERE resolved_at IS NULL').get() as { c: number }).c,
    ).toBe(0);
    // 通知详细模式默认关闭（中性文案防泄露）
    expect(
      (db.prepare('SELECT notify_verbose v FROM users WHERE id=?').get(uid) as { v: number }).v,
    ).toBe(0);
  });

  it('删被审文件级联删审查记录，审查记录再二级级联删逐条发现', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const { docId } = mkReview(db, caseId, uid);

    db.prepare('DELETE FROM company_docs WHERE id = ?').run(docId);

    for (const t of ['contract_reviews', 'review_findings']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
  });

  it('删案件直接级联删审查记录（不经 company_docs 也要断干净）', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    mkReview(db, caseId, uid);

    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    for (const t of ['company_docs', 'contract_reviews', 'review_findings']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
  });

  it('review_findings.status 默认「待处理」，且无 CHECK（值集由 lib 侧把关）', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const { findingId } = mkReview(db, caseId, uid);
    expect(
      (db.prepare('SELECT status s FROM review_findings WHERE id=?').get(findingId) as { s: string }).s,
    ).toBe('待处理');
    // 用户跟踪谈判进度：只有用户/agent 工具改这一列，审查管线不回写
    db.prepare('UPDATE review_findings SET status = ? WHERE id = ?').run('已提出', findingId);
    expect(
      (db.prepare('SELECT status s FROM review_findings WHERE id=?').get(findingId) as { s: string }).s,
    ).toBe('已提出');
    expect(() =>
      db.prepare('UPDATE review_findings SET severity = ? WHERE id = ?').run('二期新增档', findingId),
    ).not.toThrow();
  });

  it('删案件级联删盯梢，盯梢再二级级联删告警事件与检查日志', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const watchId = Number(
      db.prepare('INSERT INTO company_watches (case_id, name) VALUES (?,?)')
        .run(caseId, '某某科技有限公司').lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO company_watch_events (watch_id, kind, severity, detected_at) VALUES (?,?,?,?)",
    ).run(watchId, '简易注销公告', 'urgent', '2026-08-20');
    db.prepare("INSERT INTO company_watch_checks (watch_id, source) VALUES (?, '爱企查')").run(watchId);

    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    for (const t of ['company_watches', 'company_watch_events', 'company_watch_checks']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
  });

  it('删背调档：盯梢的 company_profile_id 置 NULL，盯梢本身存活（手输公司名照盯不误）', () => {
    const uid = mkUser(db);
    const caseId = mkCase(db, uid);
    const profileId = Number(
      db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?,?)')
        .run(caseId, '某某科技有限公司').lastInsertRowid,
    );
    const watchId = Number(
      db.prepare('INSERT INTO company_watches (case_id, company_profile_id, name) VALUES (?,?,?)')
        .run(caseId, profileId, '某某科技有限公司').lastInsertRowid,
    );

    db.prepare('DELETE FROM company_profiles WHERE id = ?').run(profileId);

    const row = db.prepare('SELECT company_profile_id, name, status FROM company_watches WHERE id=?')
      .get(watchId) as { company_profile_id: number | null; name: string; status: string };
    expect(row.company_profile_id).toBeNull();
    expect(row.name).toBe('某某科技有限公司');
    expect(row.status).toBe('active');
  });

  it('删关联主体任一端：关系边随之消失，另一端主体存活', () => {
    const caseId = mkCase(db, mkUser(db));
    const parent = mkProfile(db, caseId, '某某集团有限公司');
    const child = mkProfile(db, caseId, '某某科技有限公司');
    const ins = db.prepare(
      'INSERT INTO company_relations (case_id, from_profile_id, to_profile_id, relation) VALUES (?,?,?,?)',
    );
    ins.run(caseId, parent, child, '股权母子');

    // 删 from 端 → 边消失，to 端主体还在
    db.prepare('DELETE FROM company_profiles WHERE id=?').run(parent);
    expect((db.prepare('SELECT COUNT(*) c FROM company_relations').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM company_profiles').get() as { c: number }).c).toBe(1);

    // 删 to 端亦然（边随任一端点消亡）
    const other = mkProfile(db, caseId, '某某网络科技有限公司');
    ins.run(caseId, child, other, '对外投资');
    db.prepare('DELETE FROM company_profiles WHERE id=?').run(other);
    expect((db.prepare('SELECT COUNT(*) c FROM company_relations').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM company_profiles').get() as { c: number }).c).toBe(1);
  });

  it('删案件级联删关系边与涉诉记录（涉诉记录经 company_profiles 二级级联）', () => {
    const caseId = mkCase(db, mkUser(db));
    const a = mkProfile(db, caseId, '某某集团有限公司');
    const b = mkProfile(db, caseId, '某某科技有限公司');
    db.prepare(
      'INSERT INTO company_relations (case_id, from_profile_id, to_profile_id, relation, confidence) VALUES (?,?,?,?,?)',
    ).run(caseId, a, b, '同法定代表人', '低');
    db.prepare(
      'INSERT INTO company_litigation (company_profile_id, case_no, is_labor, role) VALUES (?,?,?,?)',
    ).run(b, '(2024)京0105民初999号', 1, '被告');

    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    for (const t of ['company_profiles', 'company_relations', 'company_litigation']) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, `${t} 未被级联删除`).toBe(0);
    }
  });

  it('users 无级联：删还有案件的用户被外键挡下', () => {
    const uid = mkUser(db);
    mkCase(db, uid);
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(uid)).toThrow(/FOREIGN KEY/);
  });
});

describe('存量迁移区', () => {
  it('redemption_codes.note / created_by：列存在，存量行取 NULL，幂等重跑不重复加列', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // 先造一张**没有这两列**的老表，模拟已上线的库
    db.exec(`
      CREATE TABLE redemption_codes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        code          TEXT NOT NULL UNIQUE,
        gongdao_value INTEGER NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        redeemed_by   INTEGER,
        redeemed_at   TEXT,
        expires_at    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO redemption_codes (code, gongdao_value) VALUES (?,?)').run('OLD-CODE', 100);

    const cols = (name: string) =>
      (db.prepare('PRAGMA table_info(redemption_codes)').all() as { name: string }[]).filter(
        (c) => c.name === name,
      ).length;
    expect(cols('note')).toBe(0);
    expect(cols('created_by')).toBe(0);

    runMigrations(db);
    expect(cols('note')).toBe(1);
    expect(cols('created_by')).toBe(1);
    // 第二遍：addColumnIfMissing 跳过，不报 duplicate column name（裸 ALTER 会在这里炸）
    expect(() => runMigrations(db)).not.toThrow();
    expect(cols('note')).toBe(1);
    expect(cols('created_by')).toBe(1);

    // 存量行原样保留，两个新列是 NULL——**不回填**「未知」之类的占位
    expect(
      db.prepare('SELECT code, gongdao_value, note, created_by FROM redemption_codes').all(),
    ).toEqual([{ code: 'OLD-CODE', gongdao_value: 100, note: null, created_by: null }]);
  });

  it('api_keys.client_name：列存在，存量行取 NULL，幂等重跑不重复加列', () => {
    // 「已上线的老库」= 跑一遍迁移拿到完整 schema，再把这一列摘掉。
    // 手写一张老 api_keys 是行不通的：它 REFERENCES users，而 users 得由迁移自己建
    // （手写一张残缺的 users 会让后面的部分索引在 email 列上炸）。
    const db = newDb();
    db.exec('ALTER TABLE api_keys DROP COLUMN client_name');
    const uid = mkUser(db, 'h');
    db.prepare('INSERT INTO api_keys (user_id, name, key_hash) VALUES (?, ?, ?)').run(
      uid,
      '旧钥匙',
      'hh',
    );

    const cols = () =>
      (db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).filter(
        (c) => c.name === 'client_name',
      ).length;
    expect(cols()).toBe(0);

    runMigrations(db);
    expect(cols()).toBe(1);
    expect(() => runMigrations(db)).not.toThrow(); // 第二遍跳过，不报 duplicate column name
    expect(cols()).toBe(1);

    // 存量行的新列是 NULL——**不回填**「未知」之类的占位：走 REST 的客户端本来就不报名字，
    // 编一个默认值等于假装我们认出了他的助手。
    expect(db.prepare('SELECT name, client_name FROM api_keys').all()).toEqual([
      { name: '旧钥匙', client_name: null },
    ]);
  });

  it('api_keys.secret_enc / rotated_at：列存在，存量行取 NULL，幂等重跑不重复加列', () => {
    const db = newDb();
    db.exec('ALTER TABLE api_keys DROP COLUMN secret_enc');
    db.exec('ALTER TABLE api_keys DROP COLUMN rotated_at');
    const uid = mkUser(db, 'secret-enc');
    db.prepare('INSERT INTO api_keys (user_id, name, key_hash) VALUES (?, ?, ?)').run(
      uid,
      '旧钥匙',
      'hh-secret',
    );

    const cols = (name: string) =>
      (db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).filter(
        (c) => c.name === name,
      ).length;
    expect(cols('secret_enc')).toBe(0);
    expect(cols('rotated_at')).toBe(0);

    runMigrations(db);
    expect(cols('secret_enc')).toBe(1);
    expect(cols('rotated_at')).toBe(1);
    // 第二遍：addColumnIfMissing 跳过，不报 duplicate column name（裸 ALTER 会在这里炸）
    expect(() => runMigrations(db)).not.toThrow();
    expect(cols('secret_enc')).toBe(1);
    expect(cols('rotated_at')).toBe(1);

    // 存量行两列取 NULL——**不回填**。这把 key 当年就没留明文，塞任何默认值都是把
    // 「找不回了」伪装成「找得回」，而页面据 secret_enc IS NULL 说的正是那句实话。
    expect(db.prepare('SELECT name, secret_enc, rotated_at FROM api_keys').all()).toEqual([
      { name: '旧钥匙', secret_enc: null, rotated_at: null },
    ]);
  });

  it('threads.intake_stage：列存在，默认 NULL 且可写读', () => {
    const db = newDb();
    const caseId = mkCase(db, mkUser(db));
    const threadId = Number(
      db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId)
        .lastInsertRowid,
    );
    // 未进状态机 → NULL
    expect(
      (db.prepare('SELECT intake_stage s FROM threads WHERE id=?').get(threadId) as { s: string | null }).s,
    ).toBeNull();
    db.prepare('UPDATE threads SET intake_stage = ? WHERE id = ?').run('D', threadId);
    expect(
      (db.prepare('SELECT intake_stage s FROM threads WHERE id=?').get(threadId) as { s: string | null }).s,
    ).toBe('D');
    // 无 DB 级 CHECK：值集外的串也存得进去（二期扩值免表迁移，值集由 lib/agent 把关）
    expect(() =>
      db.prepare('UPDATE threads SET intake_stage = ? WHERE id = ?').run('E-二期新增档', threadId),
    ).not.toThrow();
  });

  it('company_watches.tier：列存在，默认 daily 且可写读', () => {
    const db = newDb();
    const caseId = mkCase(db, mkUser(db));
    const watchId = Number(
      db.prepare('INSERT INTO company_watches (case_id, name) VALUES (?,?)')
        .run(caseId, '某某科技有限公司').lastInsertRowid,
    );
    const tier = () =>
      (db.prepare('SELECT tier t FROM company_watches WHERE id=?').get(watchId) as { t: string }).t;
    // 新盯梢默认进圈1（每日）
    expect(tier()).toBe('daily');
    // 升降档纯粹是应用层写值，库侧不管规则
    db.prepare('UPDATE company_watches SET tier = ? WHERE id = ?').run('weekly', watchId);
    expect(tier()).toBe('weekly');
    db.prepare('UPDATE company_watches SET tier = ? WHERE id = ?').run('archive', watchId);
    expect(tier()).toBe('archive');
    // 无 DB 级 CHECK：值集外的串也存得进去（值集由 watcher 侧把关）
    expect(() =>
      db.prepare('UPDATE company_watches SET tier = ? WHERE id = ?').run('二期新增圈', watchId),
    ).not.toThrow();
  });

  it('老库补 tier 列幂等：跑两遍只补一次，存量盯梢取默认 daily', () => {
    // 模拟一个 tier 落地之前的老库：建全量表后把该列摘掉，再灌一条存量盯梢
    const db = newDb();
    db.exec('ALTER TABLE company_watches DROP COLUMN tier');
    const caseId = mkCase(db, mkUser(db));
    db.prepare('INSERT INTO company_watches (case_id, name) VALUES (?,?)')
      .run(caseId, '某某科技有限公司');

    const tierCols = () =>
      (db.prepare('PRAGMA table_info(company_watches)').all() as { name: string }[]).filter(
        (c) => c.name === 'tier',
      ).length;
    expect(tierCols()).toBe(0);

    runMigrations(db);
    expect(tierCols()).toBe(1);
    runMigrations(db);
    expect(tierCols()).toBe(1);

    // 存量行还在，老列原样，新列取 DDL 默认值（老库盯梢本来就按每日跑，不需回填）
    expect(db.prepare('SELECT name, tier FROM company_watches').all()).toEqual([
      { name: '某某科技有限公司', tier: 'daily' },
    ]);
  });

  it('company_watches 守望计费四列：存在、默认对、可写读（spec v3 §2.2）', () => {
    const db = newDb();
    const cols = db.prepare('PRAGMA table_info(company_watches)').all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    // 四列必须都在（计数断言：漏加一列即缺，读侧拿到 no such column）
    for (const c of ['billing_status', 'paid_through', 'arrears_rounds', 'billed_month']) {
      expect(byName.has(c), `缺列 ${c}`).toBe(true);
    }

    const caseId = mkCase(db, mkUser(db));
    const watchId = Number(
      db.prepare('INSERT INTO company_watches (case_id, name) VALUES (?,?)')
        .run(caseId, '某某科技有限公司').lastInsertRowid,
    );
    // 新盯梢默认：尚未计费（free）、未缴期（NULL）、欠费轮数 0、未处理过任何月（NULL）
    expect(
      db.prepare(
        'SELECT billing_status, paid_through, arrears_rounds, billed_month FROM company_watches WHERE id=?',
      ).get(watchId),
    ).toEqual({ billing_status: 'free', paid_through: null, arrears_rounds: 0, billed_month: null });

    // 哑存储：应用层写什么就是什么，库侧不设 CHECK / 触发器
    db.prepare(
      "UPDATE company_watches SET billing_status='arrears', arrears_rounds=2, billed_month='202608' WHERE id=?",
    ).run(watchId);
    expect(
      (db.prepare('SELECT arrears_rounds a FROM company_watches WHERE id=?').get(watchId) as { a: number }).a,
    ).toBe(2);
  });

  it('老库补守望计费列幂等：跑两遍只补一次，存量盯梢取默认（free/0/NULL）', () => {
    const db = newDb();
    for (const c of ['billing_status', 'paid_through', 'arrears_rounds', 'billed_month']) {
      db.exec(`ALTER TABLE company_watches DROP COLUMN ${c}`);
    }
    const caseId = mkCase(db, mkUser(db));
    db.prepare('INSERT INTO company_watches (case_id, name) VALUES (?,?)').run(caseId, '某某科技');

    const count = () =>
      (db.prepare('PRAGMA table_info(company_watches)').all() as { name: string }[]).filter((c) =>
        ['billing_status', 'paid_through', 'arrears_rounds', 'billed_month'].includes(c.name),
      ).length;
    expect(count()).toBe(0);
    runMigrations(db);
    expect(count()).toBe(4);
    runMigrations(db); // 二次幂等
    expect(count()).toBe(4);

    expect(
      db.prepare(
        'SELECT billing_status, paid_through, arrears_rounds, billed_month FROM company_watches',
      ).all(),
    ).toEqual([{ billing_status: 'free', paid_through: null, arrears_rounds: 0, billed_month: null }]);
  });

  /**
   * messages.failed_code（naive-qa-2 F-203）：这一轮终态失败的错误码。
   * 老库存量行取 NULL——读侧必须容得下这个缺省（NULL = 不是失败轮），
   * 否则上线那一刻，所有历史消息会被判成失败轮，整段对话变成一屏红横幅。
   */
  it('messages.failed_code：老库补列幂等，存量行取 NULL', () => {
    const db = newDb();
    db.exec('ALTER TABLE messages DROP COLUMN failed_code');
    const caseId = mkCase(db, mkUser(db));
    const threadId = Number(
      db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid,
    );
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', '公司让我签字')").run(threadId);

    const cols = () =>
      (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).filter(
        (c) => c.name === 'failed_code',
      ).length;
    expect(cols()).toBe(0);

    runMigrations(db);
    expect(cols()).toBe(1);
    runMigrations(db); // 二次幂等：裸 ALTER 会在这里报 duplicate column name
    expect(cols()).toBe(1);

    expect(db.prepare('SELECT content, failed_code FROM messages').all()).toEqual([
      { content: '公司让我签字', failed_code: null },
    ]);
  });

  it('cases.domain：老库补列可重入，存量案件按默认值补成 labor', () => {
    // 模拟一个 domain 落地之前的老库：建全量表后把该列摘掉，再灌一条存量案件
    const db = newDb();
    db.exec('ALTER TABLE cases DROP COLUMN domain');
    const caseId = mkCase(db, mkUser(db));

    const domainCols = () =>
      (db.prepare('PRAGMA table_info(cases)').all() as { name: string }[]).filter(
        (c) => c.name === 'domain',
      ).length;
    expect(domainCols()).toBe(0);

    runMigrations(db);
    expect(domainCols()).toBe(1);
    runMigrations(db); // 二次幂等：裸 ALTER 会在这里报 duplicate column name
    expect(domainCols()).toBe(1);

    // 存量行当场按默认值补齐——不是 NULL：这一列是 NOT NULL，
    // 而"这个案子属于哪个领域"对存量行本来就有唯一正确答案（全站当时只有一个领域）。
    expect(db.prepare('SELECT domain FROM cases WHERE id = ?').get(caseId)).toEqual({
      domain: 'labor',
    });
    // 新建的案件同样吃 DDL 默认值，不需要调用方显式传
    expect(
      db.prepare('SELECT domain FROM cases WHERE id = ?').get(mkCase(db, mkUser(db, 'h2'))),
    ).toEqual({ domain: 'labor' });
  });

  it('老库补列幂等：跑两遍只补一次，原有行数据不丢', () => {
    // 模拟一个 intake_stage 落地之前的老库：建全量表后把该列摘掉，再灌一条存量线程
    const db = newDb();
    db.exec('ALTER TABLE threads DROP COLUMN intake_stage');
    const caseId = mkCase(db, mkUser(db));
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '陪跑')").run(caseId);

    const stageCols = () =>
      (db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).filter(
        (c) => c.name === 'intake_stage',
      ).length;
    expect(stageCols()).toBe(0);

    runMigrations(db);
    expect(stageCols()).toBe(1);
    runMigrations(db);
    expect(stageCols()).toBe(1);

    // 存量行还在，老列原样，新列为 NULL
    const row = db.prepare('SELECT mode, intake_stage FROM threads').all() as {
      mode: string;
      intake_stage: string | null;
    }[];
    expect(row).toEqual([{ mode: '陪跑', intake_stage: null }]);
  });
});
