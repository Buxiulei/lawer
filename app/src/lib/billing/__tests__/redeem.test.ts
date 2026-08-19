// app/src/lib/billing/__tests__/redeem.test.ts
// 兑换码核销：面值入 gongdao_ledger、CAS 防重放、幂等、各类拒绝原因。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { redeemCode, redeemReasonText } from '../redeem';
import { getGongdao } from '../index';
import { toSql } from '../../db/time';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid,
  );
  return { db, uid };
}

function makeCode(
  db: Database.Database,
  code: string,
  gongdao: number,
  extra: Partial<{ enabled: number; expires_at: string }> = {},
) {
  db.prepare('INSERT INTO redemption_codes (code, gongdao_value, enabled, expires_at) VALUES (?,?,?,?)')
    .run(code, gongdao, extra.enabled ?? 1, extra.expires_at ?? null);
}

describe('兑换码核销', () => {
  test('成功核销：公道值增加，码标记已兑换，ledger 记 兑换', () => {
    const { db, uid } = makeDb();
    makeCode(db, 'LAW-AAAA', 300);
    const r = redeemCode(db, uid, 'law-aaaa'); // 大小写不敏感
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.gongdao).toBe(300);
      expect(r.balance).toBe(300);
    }
    expect(getGongdao(uid, db)).toBe(300);
    const row = db.prepare('SELECT redeemed_by FROM redemption_codes WHERE code=?').get('LAW-AAAA') as { redeemed_by: number };
    expect(row.redeemed_by).toBe(uid);
    const log = db.prepare("SELECT delta, ref_id FROM gongdao_ledger WHERE user_id=? AND type='兑换'").get(uid) as
      { delta: number; ref_id: string };
    expect(log.delta).toBe(300);
    expect(log.ref_id).toMatch(/^redeem-\d+$/);
  });

  test('并发语义：同一码二次核销返回 used，公道值不再增加（CAS + ledger 唯一索引双兜底）', () => {
    const { db, uid } = makeDb();
    makeCode(db, 'LAW-BBBB', 100);
    expect(redeemCode(db, uid, 'LAW-BBBB').ok).toBe(true);
    const second = redeemCode(db, uid, 'LAW-BBBB');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('used');
    expect(getGongdao(uid, db)).toBe(100); // 只加一次
    expect(db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE type='兑换'").get()).toEqual({ c: 1 });
  });

  test('不存在 / 停用 / 过期各自的拒绝原因', () => {
    const { db, uid } = makeDb();
    makeCode(db, 'LAW-OFF', 100, { enabled: 0 });
    makeCode(db, 'LAW-EXP', 100, { expires_at: '2000-01-01T00:00:00.000Z' });
    const gone = redeemCode(db, uid, 'LAW-NOPE');
    const off = redeemCode(db, uid, 'LAW-OFF');
    const exp = redeemCode(db, uid, 'LAW-EXP');
    expect([gone, off, exp].map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['not_found', 'disabled', 'expired']);
    expect(getGongdao(uid, db)).toBe(0);
  });

  test('有效期按 UTC 判（ADR-002）：canonical 串写的未来到期码仍可兑换', () => {
    const { db, uid } = makeDb();
    const hours = (n: number) => toSql(new Date(Date.now() + n * 3600_000));
    makeCode(db, 'LAW-FUTURE', 100, { expires_at: hours(4) });  // 4 小时后到期
    makeCode(db, 'LAW-PAST', 100, { expires_at: hours(-4) });   // 4 小时前已过期
    // 旧写法把 canonical 串当本机时区解析，在 UTC+8 上会把这张有效码误判成已过期
    expect(redeemCode(db, uid, 'LAW-FUTURE').ok).toBe(true);
    const past = redeemCode(db, uid, 'LAW-PAST');
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe('expired');
  });

  test('拒绝原因有中文文案', () => {
    expect(redeemReasonText('used')).toBe('兑换码已被使用');
    expect(redeemReasonText('not_found')).toBe('兑换码不存在');
  });
});
