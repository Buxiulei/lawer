import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import * as store from '../realname';

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  userId = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
});

describe('realname_verifications', () => {
  it('写入后可读回，status 缺省 pending', () => {
    const id = store.insertVerification(db, { userId, provider: 'cloudauth' });
    const got = store.latestByUser(db, userId)!;
    expect(got.id).toBe(id);
    expect(got.provider).toBe('cloudauth');
    expect(got.status).toBe('pending');
    expect(got.cert_no).toBeNull();
    expect(got.raw_meta_enc).toBeNull();
  });

  it('raw_meta_enc 原样存取（本层只接密文，不认识明文）', () => {
    store.insertVerification(db, {
      userId,
      provider: 'eid',
      certNo: 'cert-001',
      rawMetaEnc: 'enc:AAAABBBBCCCC',
    });
    const got = store.latestByUser(db, userId)!;
    expect(got.cert_no).toBe('cert-001');
    expect(got.raw_meta_enc).toBe('enc:AAAABBBBCCCC');
  });

  it('只追加：改名/换证是新一行，latestByUser 取最近一条', () => {
    store.insertVerification(db, { userId, provider: 'manual', status: 'rejected' });
    const second = store.insertVerification(db, { userId, provider: 'cloudauth', status: 'passed' });
    expect(store.latestByUser(db, userId)?.id).toBe(second);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM realname_verifications').get() as { c: number }).c,
    ).toBe(2);
  });

  it('setStatus 推进指定那一行，不动其它行', () => {
    const first = store.insertVerification(db, { userId, provider: 'manual' });
    const second = store.insertVerification(db, { userId, provider: 'cloudauth' });
    store.setStatus(db, second, 'passed');
    const rows = db
      .prepare('SELECT id, status FROM realname_verifications ORDER BY id')
      .all() as { id: number; status: string }[];
    expect(rows).toEqual([
      { id: first, status: 'pending' },
      { id: second, status: 'passed' },
    ]);
  });

  it('latestByUser 只看本人，没记录时回 undefined', () => {
    const other = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h2').lastInsertRowid);
    store.insertVerification(db, { userId, provider: 'cloudauth' });
    expect(store.latestByUser(db, other)).toBeUndefined();
  });

  it('latestVerificationIdForUser 给的是 MAX(id)，没记录时回 null', () => {
    const other = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h3').lastInsertRowid);
    expect(store.latestVerificationIdForUser(db, userId)).toBe(null);
    const first = store.insertVerification(db, { userId, provider: 'passport' });
    const second = store.insertVerification(db, { userId, provider: 'passport' });
    expect(second).toBeGreaterThan(first);
    // 【变异对照】写成 MIN(id) 或"最后一次插入"→ 这里拿到 first → 红
    expect(store.latestVerificationIdForUser(db, userId)).toBe(second);
    // 只看本人：别人的流水不许影响这个数
    expect(store.latestVerificationIdForUser(db, other)).toBe(null);
  });

  it('接口面只读+插入，删除只此一个且只给注销用；不碰 users.auth_status', () => {
    // findById 是 2026-08-29 护照通道加的：人工审核要先读出材料哈希与信封再决定落不落定。
    // listPendingByProvider 是 2026-09-03 后台审核台加的：仍是只读（一条 SELECT）。
    // latestVerificationIdForUser 同日加：审核落定前比一次 MAX(id)，仍是只读。
    // listByUser / deleteAllByUser 是 2026-09-07 注销那条路加的，**是这张表上唯一的删除口**：
    // 这几行里装着姓名与证件号（raw_meta_enc 明写「内含姓名身份证」），而注销回包对用户说的是
    // 「姓名与证件号已经抹掉」。谁调它由 lib/lifecycle/__tests__/identity-erase 的结构守卫钉着
    // （除 identity-erase 外不许有第二个调用方）。
    // 这张清单**故意钉死全集**——新增导出必须来这里改一次，
    // 否则"这个模块只读+插入"这句保证会随每次顺手加函数而悄悄失效。
    expect(Object.keys(store).sort()).toEqual([
      'deleteAllByUser',
      'findById',
      'insertVerification',
      'latestByUser',
      'latestVerificationIdForUser',
      'listByUser',
      'listPendingByProvider',
      'setStatus',
    ]);
    store.insertVerification(db, { userId, provider: 'cloudauth', status: 'passed' });
    expect(
      (db.prepare('SELECT auth_status s FROM users WHERE id=?').get(userId) as { s: string }).s,
    ).toBe('未认证');
  });
});
