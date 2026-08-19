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

  it('接口面只读+插入：模块不导出 delete，也不碰 users.auth_status', () => {
    expect(Object.keys(store).sort()).toEqual(['insertVerification', 'latestByUser', 'setStatus']);
    store.insertVerification(db, { userId, provider: 'cloudauth', status: 'passed' });
    expect(
      (db.prepare('SELECT auth_status s FROM users WHERE id=?').get(userId) as { s: string }).s,
    ).toBe('未认证');
  });
});
