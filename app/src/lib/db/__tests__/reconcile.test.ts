// app/src/lib/db/__tests__/reconcile.test.ts
// 对账器（scripts/reconcile.ts 的逻辑本体）：正常账目零问题，三类不一致各自被抓出，
// 「有消耗流水无 token_usage」只警告不判错（定额端点本就不产 token）。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import { reconcile } from '../reconcile';
import { gongdaoGrant, gongdaoSettle, recordTokenUsage } from '../../billing/index';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const mk = (email: string) =>
    Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
  const [u1, u2] = [mk('u1@t.com'), mk('u2@t.com')];

  gongdaoGrant(u1, 1000, GONGDAO_LEDGER_TYPE.register, `reg-${u1}`, null, db);
  recordTokenUsage(u1, 'intake', 'deepseek-v3', { promptTokens: 12000, completionTokens: 4000 }, 'intake-u1', db);
  gongdaoSettle(u1, 17, 'intake-u1', 'intake', db);

  gongdaoGrant(u2, 5000, GONGDAO_LEDGER_TYPE.recharge, 'ORD-u2', null, db);
  gongdaoSettle(u2, 2000, 'attest-u2', 'attest', db); // 定额端点，无 token_usage

  return { db, u1, u2 };
}

describe('reconcile', () => {
  test('账目一致：零 problems；定额消耗只出警告', () => {
    const { db } = makeDb();
    const r = reconcile(db);
    expect(r.problems).toEqual([]);
    expect(r.users).toBe(2);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('attest-u2');
  });

  test('物化余额被改坏 → 报出差额', () => {
    const { db, u2 } = makeDb();
    db.prepare('UPDATE gongdao SET balance = balance + 7 WHERE user_id=?').run(u2);
    const r = reconcile(db);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/差 7/);
  });

  test('有流水无余额行 → 判错', () => {
    const { db, u1 } = makeDb();
    db.prepare('DELETE FROM gongdao WHERE user_id=?').run(u1);
    const r = reconcile(db);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/无 gongdao 余额行/);
  });

  test('有余额行无流水（且非 0）→ 判错；余额为 0 则放行', () => {
    const { db } = makeDb();
    const ghost = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('g@t.com').lastInsertRowid);
    db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, 0)').run(ghost);
    expect(reconcile(db).problems).toEqual([]);
    db.prepare('UPDATE gongdao SET balance=5 WHERE user_id=?').run(ghost);
    expect(reconcile(db).problems[0]).toMatch(/无任何流水/);
  });

  test('token_usage 有用量却无消耗流水 → 判错（漏扣）', () => {
    const { db, u1 } = makeDb();
    recordTokenUsage(u1, 'companion', 'deepseek-v3', { promptTokens: 5000 }, 'companion-lost', db);
    const r = reconcile(db);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/companion-lost/);
  });
});
