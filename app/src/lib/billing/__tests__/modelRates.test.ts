// app/src/lib/billing/__tests__/modelRates.test.ts
// 模型费率取用与计价精度：无行走兜底、只追加不修改（取最新生效行）、未生效行不参与、
// 四档分桶各按自己的费率算、cost_li 精度（手算锚点）。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { getRatesForModel, setModelRate } from '../../db/modelRates';
import { DEFAULT_RATES, costLiOfUsage, costOfUsage, exactGongdaoOfUsage } from '../pricing';
import { recordTokenUsage } from '../index';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid,
  );
  return { db, uid };
}

/** SQLite datetime('now') 同格式（UTC，'YYYY-MM-DD HH:MM:SS'）的相对时刻。 */
const at = (offsetMs: number) =>
  new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

const DAY = 86_400_000;

describe('getRatesForModel', () => {
  test('该模型无任何费率行 → 三档全部走 DEFAULT_RATES', () => {
    const { db } = makeDb();
    expect(getRatesForModel(db, 'never-configured')).toEqual(DEFAULT_RATES);
  });

  test('只配了 in 档 → 另两档各自回落 DEFAULT_RATES', () => {
    const { db } = makeDb();
    setModelRate(db, 'partial', 'in', 0.001);
    expect(getRatesForModel(db, 'partial')).toEqual({
      in: 0.001, out: DEFAULT_RATES.out, cache: DEFAULT_RATES.cache,
    });
  });

  test('同档两条不同 effective_at → 取已生效的最新那条', () => {
    const { db } = makeDb();
    setModelRate(db, 'm', 'in', 0.001, at(-2 * DAY));
    setModelRate(db, 'm', 'in', 0.002, at(-1 * DAY));
    expect(getRatesForModel(db, 'm').in).toBe(0.002);
  });

  test('未来生效的行不参与计价（改价不提前生效）', () => {
    const { db } = makeDb();
    setModelRate(db, 'm', 'out', 0.004, at(-1 * DAY));
    setModelRate(db, 'm', 'out', 0.009, at(+30 * DAY));
    expect(getRatesForModel(db, 'm').out).toBe(0.004);
  });

  test('费率只追加不修改：同 (model, kind, effective_at) 二次写入被唯一索引挡下', () => {
    const { db } = makeDb();
    const t = at(-1 * DAY);
    setModelRate(db, 'm', 'cache', 0.0001, t);
    expect(() => setModelRate(db, 'm', 'cache', 0.0002, t)).toThrow(/UNIQUE/);
  });

  test('模型之间互不串档', () => {
    const { db } = makeDb();
    setModelRate(db, 'a', 'in', 0.001);
    expect(getRatesForModel(db, 'b')).toEqual(DEFAULT_RATES);
  });
});

describe('四档分桶计价与 cost_li 精度', () => {
  test('手算锚点（自配费率）：prompt/completion/cached/embed 各按自己的档计', () => {
    const rates = { in: 0.001, out: 0.004, cache: 0.0001 };
    const usage = { promptTokens: 1000, completionTokens: 500, cachedTokens: 2000, embedTokens: 300 };
    // 1000×0.001 + 500×0.004 + 2000×0.0001 + 300×0.001 = 1 + 2 + 0.2 + 0.3 = 3.5
    expect(exactGongdaoOfUsage(usage, rates)).toBeCloseTo(3.5, 10);
    expect(costLiOfUsage(usage, rates)).toBe(3500);
    expect(costOfUsage(usage, rates)).toBe(4); // ceil 整数入账
  });

  test('cached 走 cache 档而非 in 档：同样 token 数，缓存命中显著便宜', () => {
    const rates = { in: 0.001, out: 0.004, cache: 0.0001 };
    const asPrompt = costLiOfUsage({ promptTokens: 10_000 }, rates);
    const asCached = costLiOfUsage({ cachedTokens: 10_000 }, rates);
    expect(asPrompt).toBe(10_000);
    expect(asCached).toBe(1_000);
  });

  test('embed 按 in 档计（无独立 embed 档）', () => {
    const rates = { in: 0.001, out: 0.004, cache: 0.0001 };
    expect(costLiOfUsage({ embedTokens: 700 }, rates)).toBe(costLiOfUsage({ promptTokens: 700 }, rates));
  });

  test('recordTokenUsage 用 model_rates 的费率而非兜底：改价后新流水按新价记', () => {
    const { db, uid } = makeDb();
    setModelRate(db, 'claude-x', 'in', 0.001, at(-2 * DAY));
    setModelRate(db, 'claude-x', 'out', 0.004, at(-2 * DAY));
    setModelRate(db, 'claude-x', 'cache', 0.0001, at(-2 * DAY));
    recordTokenUsage(uid, 'intake', 'claude-x', { promptTokens: 1000, completionTokens: 500, cachedTokens: 2000 }, 'r-1', db);
    // 1 + 2 + 0.2 = 3.2 公道值 → 3200 厘
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-1'").get()).toEqual({ cost_li: 3200 });

    setModelRate(db, 'claude-x', 'in', 0.002, at(-1 * DAY)); // 输入档涨价
    recordTokenUsage(uid, 'intake', 'claude-x', { promptTokens: 1000, completionTokens: 500, cachedTokens: 2000 }, 'r-2', db);
    // 2 + 2 + 0.2 = 4.2 → 4200 厘；旧流水不被回溯改写
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-2'").get()).toEqual({ cost_li: 4200 });
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-1'").get()).toEqual({ cost_li: 3200 });
  });

  test('DEFAULT_RATES 锚点：DeepSeek V3 官牌价换算值（待 M3 核定）', () => {
    expect(DEFAULT_RATES.in).toBeCloseTo(0.0006, 12);
    expect(DEFAULT_RATES.out).toBeCloseTo(0.0024, 12);
    expect(DEFAULT_RATES.cache).toBeCloseTo(0.00015, 12);
  });
});
