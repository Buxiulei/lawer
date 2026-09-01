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
  gongdaoSettle(u1, 17, 'intake-u1', 'intake', null, db);

  gongdaoGrant(u2, 5000, GONGDAO_LEDGER_TYPE.recharge, 'ORD-u2', null, db);
  gongdaoSettle(u2, 2000, 'attest-u2', 'attest', null, db); // 定额端点，无 token_usage

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
      gongdaoSettle(u1, 1, ref, 'ocr', null, db); // 配一条消耗流水，避免触发「用量无落账」那条判错
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
      gongdaoSettle(u1, 1, ref, 'ocr', null, db);
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

// ───────────────── 空账本告警（2026-08-25，生产冒烟：三表全 0 行而对账报绿）─────────────────
// 这条检查的意义不在"多抓一种不一致"，而在**堵住报绿的那条路**：
// 三表全空时上面每一条检查都无行可查，于是「零不一致」——一个报绿的对账器
// 会让所有人相信账是对的，从而没人再去看账本。**空表不是账目一致，是根本没记账。**
describe('reconcile · 空账本', () => {
  /** 造一轮真实发生过的对话：cases → threads → messages(assistant)，但不落任何账 */
  function withAssistantMessage(db: Database.Database, userId: number): void {
    const caseId = Number(
      db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '张三诉某公司违法解除')").run(userId).lastInsertRowid,
    );
    const threadId = Number(db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid);
    db.prepare("INSERT INTO messages (thread_id, role, content, tokens_json) VALUES (?, 'assistant', '回复正文', ?)").run(
      threadId,
      JSON.stringify({ model: 'DeepSeek-V4-Pro-0813', usage: { prompt: 100, completion: 20, cachedRead: null, cachedWrite: null } }),
    );
  }

  test('阳性对照：有模型回复却零 token_usage → 必须判错（差分有效性自证）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('empty@t.com').lastInsertRowid);
    withAssistantMessage(db, uid);

    const r = reconcile(db);
    // 只有空表这一条报错：证明**其余每一条检查在这个状态下都是绿的**——
    // 这正是修前"零不一致"的来源，也是这条检查存在的理由。
    expect(r.problems).toHaveLength(2); // token_usage 空 + 消耗流水空
    expect(r.problems.join('\n')).toMatch(/账本空表/);
    expect(r.problems.join('\n')).toMatch(/token_usage/);
    expect(r.problems.join('\n')).toMatch(/消耗/);
  });

  test('记了账就不报：同样有模型回复，但用量与消耗流水都在', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('ok@t.com').lastInsertRowid);
    withAssistantMessage(db, uid);
    gongdaoGrant(uid, 1000, GONGDAO_LEDGER_TYPE.register, `reg-${uid}`, null, db);
    recordTokenUsage(uid, 'intake', 'DeepSeek-V4-Pro-0813', { promptTokens: 100, completionTokens: 20 }, 'turn-1', 'deepseek-v4-pro', db);
    gongdaoSettle(uid, 1, 'turn-1', 'intake', null, db);

    expect(reconcile(db).problems).toEqual([]);
  });

  test('全新库（一条模型回复都没有）不报错——没发生过的事不算漏账', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(reconcile(db).problems).toEqual([]);
  });

  test('只有用户消息、模型还没回（生成中）不报错', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid);
    const caseId = Number(db.prepare("INSERT INTO cases (user_id, title) VALUES (?, 't')").run(uid).lastInsertRowid);
    const threadId = Number(db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', '我被裁了')").run(threadId);
    expect(reconcile(db).problems).toEqual([]);
  });
});
