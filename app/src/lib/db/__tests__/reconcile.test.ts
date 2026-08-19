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
  recordTokenUsage(u1, 'intake', 'deepseek-v3', { promptTokens: 12000, completionTokens: 4000 }, 'intake-u1', null, db);
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

  test('api_model 漂移 → 只告警不判错，且点名最新值与众值', () => {
    const { db, u1 } = makeDb();
    const rec = (apiModel: string, ref: string) => {
      recordTokenUsage(u1, 'ocr', 'qwen-vl-ocr-2025-11-20', { promptTokens: 100 }, ref, apiModel, db);
      gongdaoSettle(u1, 1, ref, 'ocr', db); // 配一条消耗流水，避免触发「用量无落账」那条判错
    };
    rec('qwen-vl-ocr-2025-11-20', 'd-1');
    rec('qwen-vl-ocr-2025-11-20', 'd-2');
    rec('qwen-vl-ocr-2026-05-01', 'd-3'); // 厂商把别名重指向了新快照

    const r = reconcile(db);
    expect(r.problems).toEqual([]); // 漂移不判错
    const drift = r.warnings.filter((w) => w.includes('计费口径漂移'));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('model=qwen-vl-ocr-2025-11-20');
    expect(drift[0]).toContain('2 个 api_model');
    expect(drift[0]).toContain('最新=qwen-vl-ocr-2026-05-01');
    expect(drift[0]).toContain('众值=qwen-vl-ocr-2025-11-20');
  });

  test('同一 model 始终只有一个 api_model → 无漂移告警', () => {
    const { db, u1 } = makeDb();
    for (const ref of ['s-1', 's-2', 's-3']) {
      recordTokenUsage(u1, 'ocr', 'qwen-vl-ocr-2025-11-20', { promptTokens: 100 }, ref, 'qwen-vl-ocr', db);
      gongdaoSettle(u1, 1, ref, 'ocr', db);
    }
    const r = reconcile(db);
    expect(r.warnings.filter((w) => w.includes('计费口径漂移'))).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  test('api_model 全为 NULL（历史行）不触发漂移告警', () => {
    const { db } = makeDb(); // makeDb 里的两条用量都没传 api_model
    expect(reconcile(db).warnings.filter((w) => w.includes('计费口径漂移'))).toEqual([]);
  });

  test('token_usage 有用量却无消耗流水 → 判错（漏扣）', () => {
    const { db, u1 } = makeDb();
    recordTokenUsage(u1, 'companion', 'deepseek-v3', { promptTokens: 5000 }, 'companion-lost', null, db);
    const r = reconcile(db);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/companion-lost/);
  });
});
