// app/src/lib/billing/__tests__/backfill.test.ts
// 窗口期回填：把「已发生但没记账」的轮从 messages.tokens_json 补进账本。
// 钉三件：幂等（跑两次不双扣）、默认只算不写、四桶全 null 的轮不补（不许拿 0 冒充）。
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { reconcile } from '../../db/reconcile';
import { backfillTokenUsage } from '../backfill';
import { getGongdao, gongdaoGrant } from '../index';
import { GONGDAO_LEDGER_TYPE } from '../pricing';

const USAGE = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'DeepSeek-V4-Pro-0813',
    usage: { prompt: 1000, completion: 200, cachedRead: null, cachedWrite: null, ...over },
  });

function makeDb(rows: (string | null)[] = [USAGE()]) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const userId = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid);
  gongdaoGrant(userId, 1000, GONGDAO_LEDGER_TYPE.register, `reg-${userId}`, null, db);
  const caseId = Number(db.prepare("INSERT INTO cases (user_id, title) VALUES (?, 't')").run(userId).lastInsertRowid);
  const threadId = Number(db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid);
  for (const tokensJson of rows) {
    db.prepare("INSERT INTO messages (thread_id, role, content, tokens_json) VALUES (?, 'assistant', 'x', ?)").run(
      threadId,
      tokensJson,
    );
  }
  return { db, userId };
}

const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('窗口期回填', () => {
  test('默认只算不写：报告说得出补多少，但一行都没落', () => {
    const { db } = makeDb();
    const r = backfillTokenUsage(db);
    expect(r.applied).toBe(false);
    expect(r.scanned).toBe(1);
    expect(r.backfilled).toBe(1);
    expect(r.gongdao).toBeGreaterThan(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type='消耗'")).toBe(0);
  });

  test('apply 后用量与消耗都补上，且对账器随之转绿', () => {
    const { db, userId } = makeDb();
    const before = getGongdao(userId, db);
    const r = backfillTokenUsage(db, true);
    expect(r.applied).toBe(true);
    expect(r.backfilled).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type='消耗'")).toBe(1);
    expect(getGongdao(userId, db)).toBe(before - r.gongdao);
    expect(reconcile(db).problems).toEqual([]);
    // 窗口期要能说得出起止——PR 里记录的就是这两个值
    expect(r.windowFrom).toBeTruthy();
    expect(r.windowTo).toBeTruthy();
  });

  test('跑两次不双扣（幂等）', () => {
    const { db, userId } = makeDb();
    backfillTokenUsage(db, true);
    const afterFirst = getGongdao(userId, db);
    const second = backfillTokenUsage(db, true);
    expect(second.backfilled).toBe(0);
    expect(second.alreadyRecorded).toBe(1);
    expect(getGongdao(userId, db)).toBe(afterFirst);
    expect(count(db, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(1);
  });

  test('当时就没回报计量的轮不补（四桶全 null ≠ 用量为 0）', () => {
    const { db } = makeDb([USAGE({ prompt: null, completion: null })]);
    const r = backfillTokenUsage(db, true);
    expect(r.unreported).toBe(1);
    expect(r.backfilled).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(0);
  });

  test('tokens_json 坏了 / 缺 model → 单列计数，不猜也不补', () => {
    const { db } = makeDb(['{不是json', JSON.stringify({ usage: { prompt: 1 } })]);
    const r = backfillTokenUsage(db, true);
    expect(r.malformed).toBe(2);
    expect(r.backfilled).toBe(0);
  });

  test('已记过账的轮不重复补（实时记账与回填共用同一个 ref 约定）', () => {
    const { db } = makeDb([USAGE(), USAGE()]);
    const first = backfillTokenUsage(db, true);
    expect(first.backfilled).toBe(2);
    // 再插一轮新的：只补新的那一轮
    const threadId = (db.prepare('SELECT id FROM threads LIMIT 1').get() as { id: number }).id;
    db.prepare("INSERT INTO messages (thread_id, role, content, tokens_json) VALUES (?, 'assistant', 'x', ?)").run(
      threadId,
      USAGE(),
    );
    const second = backfillTokenUsage(db, true);
    expect(second.backfilled).toBe(1);
    expect(second.alreadyRecorded).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 型号对账（评测遗留②）：回填也是**记账点**。只在实时那条路上按实际型号计价、
// 补记的仍按请求型号算，会让同一笔账因为「走了哪条路」而是两个数——那是对账永远填不平的坑。
// ─────────────────────────────────────────────────────────────────────────────
const RELAY_USAGE = (servedModel?: string | null) =>
  JSON.stringify({
    model: 'relay/claude-opus-5',
    usage: { prompt: 1000, completion: 200, cachedRead: null, cachedWrite: null },
    ...(servedModel === undefined ? {} : { servedModel }),
  });

describe('回填走同一条型号对账', () => {
  const row = (db: Database.Database) =>
    db.prepare("SELECT model, api_model FROM token_usage").get() as { model: string; api_model: string | null };
  const ledger = (db: Database.Database) =>
    db.prepare("SELECT delta, meta_json FROM gongdao_ledger WHERE type='消耗'").get() as {
      delta: number;
      meta_json: string | null;
    };

  test('落库时记着「实际由 sonnet 服务」→ 补记按 sonnet 计价并留痕', () => {
    const { db } = makeDb([RELAY_USAGE('claude-sonnet-5')]);
    backfillTokenUsage(db, true);
    expect(row(db).model).toBe('relay/claude-sonnet-5');
    expect(row(db).api_model).toBe('claude-sonnet-5');
    expect(JSON.parse(ledger(db).meta_json!)).toMatchObject({
      requested: 'relay/claude-opus-5',
      served: 'claude-sonnet-5',
      billed: 'relay/claude-sonnet-5',
      verdict: 'substituted',
    });
  });

  test('补记的钱与实时那条路算出来的是同一个数（不是各算各的）', () => {
    const sub = makeDb([RELAY_USAGE('claude-sonnet-5')]);
    const same = makeDb([RELAY_USAGE('claude-sonnet-5')]);
    const opus = makeDb([RELAY_USAGE('claude-opus-5')]);
    const rSub = backfillTokenUsage(sub.db, true);
    backfillTokenUsage(same.db, true);
    const rOpus = backfillTokenUsage(opus.db, true);
    // 同一份四桶，按 sonnet 算出来的钱必须**少于**按 opus 算的——否则本条测不出东西
    expect(rSub.gongdao).toBeLessThan(rOpus.gongdao);
    expect(-ledger(sub.db).delta).toBe(rSub.gongdao);
    expect(-ledger(same.db).delta).toBe(rSub.gongdao); // 确定性：同输入同结果
  });

  test('历史行没有 servedModel 这个键 → 按「未回显」走原价，不崩不留痕', () => {
    const { db } = makeDb([RELAY_USAGE()]); // 键整个缺席，正是 2026-09-01 之前落的行
    const r = backfillTokenUsage(db, true);
    expect(r.backfilled).toBe(1);
    expect(row(db).model).toBe('relay/claude-opus-5');
    expect(row(db).api_model).toBeNull();
    expect(ledger(db).meta_json).toBeNull();
  });

  test('显式 null 的 servedModel 同样按「未回显」处理', () => {
    const { db } = makeDb([RELAY_USAGE(null)]);
    expect(backfillTokenUsage(db, true).backfilled).toBe(1);
    expect(row(db).model).toBe('relay/claude-opus-5');
    expect(ledger(db).meta_json).toBeNull();
  });
});
