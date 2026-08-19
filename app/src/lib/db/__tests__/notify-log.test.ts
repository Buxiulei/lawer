import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import * as store from '../notify-log';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

const key = { scene: 'deadline', bizKey: 'case-1-d7', channel: 'sms' };

describe('tryMarkSent 幂等闸门', () => {
  it('首次抢到返 true，二次返 false（调用方不得重发）', () => {
    expect(store.tryMarkSent(db, key)).toBe(true);
    expect(store.tryMarkSent(db, key)).toBe(false);
    // 只落一行
    expect((db.prepare('SELECT COUNT(*) c FROM notify_log').get() as { c: number }).c).toBe(1);
  });

  it('每通道各自独立：短信成功不挡邮件', () => {
    expect(store.tryMarkSent(db, key)).toBe(true);
    expect(store.tryMarkSent(db, { ...key, channel: 'email' })).toBe(true);
    expect(store.tryMarkSent(db, { ...key, channel: 'email' })).toBe(false);
  });

  it('不同业务键互不影响', () => {
    expect(store.tryMarkSent(db, key)).toBe(true);
    expect(store.tryMarkSent(db, { ...key, bizKey: 'case-1-d3' })).toBe(true);
    expect(store.tryMarkSent(db, { ...key, scene: 'hearing' })).toBe(true);
  });

  it('先失败若干次再成功：失败行不占成功位', () => {
    store.logAttempt(db, { ...key, status: 'failed', detail: '短信网关 -34 签名未报备' });
    store.logAttempt(db, { ...key, status: 'failed', detail: '短信网关 -14 余额不足' });
    expect(store.tryMarkSent(db, key)).toBe(true);
    expect(store.tryMarkSent(db, key)).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM notify_log').get() as { c: number }).c).toBe(3);
  });
});

describe('logAttempt', () => {
  it('failed 带原文正常落行', () => {
    const id = store.logAttempt(db, { ...key, status: 'failed', detail: 'SMTP 550 mailbox unavailable' });
    const row = db.prepare('SELECT status, detail FROM notify_log WHERE id=?').get(id) as {
      status: string;
      detail: string;
    };
    expect(row).toEqual({ status: 'failed', detail: 'SMTP 550 mailbox unavailable' });
  });

  it('failed 且 detail 为空直接抛错，且不落行（禁止只写「发送失败」）', () => {
    expect(() => store.logAttempt(db, { ...key, status: 'failed', detail: '' })).toThrow(/失败原因/);
    expect(() => store.logAttempt(db, { ...key, status: 'failed', detail: '   ' })).toThrow(/失败原因/);
    expect((db.prepare('SELECT COUNT(*) c FROM notify_log').get() as { c: number }).c).toBe(0);
  });

  it('failed 可重复落行（每次重试都留痕）', () => {
    store.logAttempt(db, { ...key, status: 'failed', detail: '第一次：网关超时' });
    store.logAttempt(db, { ...key, status: 'failed', detail: '第二次：网关超时' });
    expect((db.prepare('SELECT COUNT(*) c FROM notify_log').get() as { c: number }).c).toBe(2);
  });

  it('skipped 不受 detail 非空约束（用户关了这个通道之类，本就没有三方原文）', () => {
    expect(() => store.logAttempt(db, { ...key, status: 'skipped', detail: '' })).not.toThrow();
  });
});

describe('wasSent', () => {
  it('只认 sent：失败/跳过都不算发过', () => {
    expect(store.wasSent(db, key.scene, key.bizKey, key.channel)).toBe(false);
    store.logAttempt(db, { ...key, status: 'failed', detail: '网关超时' });
    store.logAttempt(db, { ...key, status: 'skipped', detail: '用户已关闭短信通知' });
    expect(store.wasSent(db, key.scene, key.bizKey, key.channel)).toBe(false);
    store.tryMarkSent(db, key);
    expect(store.wasSent(db, key.scene, key.bizKey, key.channel)).toBe(true);
  });

  it('按通道分别判定', () => {
    store.tryMarkSent(db, key);
    expect(store.wasSent(db, key.scene, key.bizKey, 'email')).toBe(false);
  });
});
