// app/src/lib/billing/__tests__/modelRates.test.ts
// 模型费率取用与计价精度：无行走兜底、只追加不修改（取最新生效行）、未生效行不参与、
// 四档分桶各按自己的费率算、cost_li 精度（手算锚点）、C01 种子幂等与换算正确。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { getRatesForModel, setModelRate, seedModelRates, SEEDED_MODELS } from '../../db/modelRates';
import {
  DEFAULT_RATES,
  USD_CNY_RATE,
  GONGDAO_PER_YUAN_TOKEN_COST,
  costLiOfUsage,
  costOfUsage,
  exactGongdaoOfUsage,
  type TokenRates,
} from '../pricing';
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

/** 测试用四档费率（整数好手算，与任何真实模型无关）。 */
const RATES: TokenRates = { in: 0.001, out: 0.004, cacheRead: 0.0001, cacheWrite: 0.00125 };

describe('getRatesForModel', () => {
  test('该模型无任何费率行 → 四档全部走 DEFAULT_RATES', () => {
    const { db } = makeDb();
    expect(getRatesForModel(db, 'never-configured')).toEqual(DEFAULT_RATES);
  });

  test('只配了 in 档 → 另三档各自回落 DEFAULT_RATES', () => {
    const { db } = makeDb();
    setModelRate(db, 'partial', 'in', 0.001);
    expect(getRatesForModel(db, 'partial')).toEqual({
      in: 0.001,
      out: DEFAULT_RATES.out,
      cacheRead: DEFAULT_RATES.cacheRead,
      cacheWrite: DEFAULT_RATES.cacheWrite,
    });
  });

  test('四档齐配 → 全部取自表，token_kind 正确映射到 TokenRates 字段', () => {
    const { db } = makeDb();
    setModelRate(db, 'full', 'in', 0.001);
    setModelRate(db, 'full', 'out', 0.004);
    setModelRate(db, 'full', 'cache_read', 0.0001);
    setModelRate(db, 'full', 'cache_write', 0.00125);
    expect(getRatesForModel(db, 'full')).toEqual(RATES);
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
    setModelRate(db, 'm', 'cache_read', 0.0001, t);
    expect(() => setModelRate(db, 'm', 'cache_read', 0.0002, t)).toThrow(/UNIQUE/);
  });

  test('token_kind 受 CHECK 约束：旧的 cache 档已不再合法', () => {
    const { db } = makeDb();
    expect(() =>
      db.prepare('INSERT INTO model_rates (model, token_kind, gongdao_per_token) VALUES (?,?,?)')
        .run('m', 'cache', 0.0001),
    ).toThrow(/CHECK/);
  });

  test('变体串是独立模型：qwen-plus:think 与 qwen-plus:nothink 各记各的', () => {
    const { db } = makeDb();
    setModelRate(db, 'qwen-plus:think', 'out', 0.0024);
    setModelRate(db, 'qwen-plus:nothink', 'out', 0.0006);
    expect(getRatesForModel(db, 'qwen-plus:think').out).toBe(0.0024);
    expect(getRatesForModel(db, 'qwen-plus:nothink').out).toBe(0.0006);
    expect(getRatesForModel(db, 'qwen-plus')).toEqual(DEFAULT_RATES); // 裸名没配就是没配
  });

  test('meta_json 随费率行落库（出处可追溯）', () => {
    const { db } = makeDb();
    setModelRate(db, 'm', 'in', 0.001, at(-1 * DAY), { 源URL: 'https://example.test', 官方原价: 2 });
    const row = db.prepare('SELECT meta_json FROM model_rates WHERE model=?').get('m') as { meta_json: string };
    expect(JSON.parse(row.meta_json)).toEqual({ 源URL: 'https://example.test', 官方原价: 2 });
  });
});

describe('四档分桶计价与 cost_li 精度', () => {
  test('手算锚点：prompt/completion/cache_read/cache_write/embed 各按自己的档计', () => {
    const usage = {
      promptTokens: 1000, completionTokens: 500,
      cacheReadTokens: 2000, cacheWriteTokens: 800, embedTokens: 300,
    };
    // 1000×0.001 + 500×0.004 + 2000×0.0001 + 800×0.00125 + 300×0.001
    // = 1 + 2 + 0.2 + 1 + 0.3 = 4.5
    expect(exactGongdaoOfUsage(usage, RATES)).toBeCloseTo(4.5, 10);
    expect(costLiOfUsage(usage, RATES)).toBe(4500);
    expect(costOfUsage(usage, RATES)).toBe(5); // ceil 整数入账
  });

  test('三档输入价差不可混算：同样 10000 token，缓存读最便宜、缓存写比标准输入贵', () => {
    const asPrompt = costLiOfUsage({ promptTokens: 10_000 }, RATES);
    const asCacheRead = costLiOfUsage({ cacheReadTokens: 10_000 }, RATES);
    const asCacheWrite = costLiOfUsage({ cacheWriteTokens: 10_000 }, RATES);
    expect(asCacheRead).toBe(1_000);   // 0.1×
    expect(asPrompt).toBe(10_000);     // 1×
    expect(asCacheWrite).toBe(12_500); // 1.25×
    expect(asCacheRead).toBeLessThan(asPrompt);
    expect(asCacheWrite).toBeGreaterThan(asPrompt);
  });

  test('embed 按 in 档计（无独立 embed 档）', () => {
    expect(costLiOfUsage({ embedTokens: 700 }, RATES)).toBe(costLiOfUsage({ promptTokens: 700 }, RATES));
  });

  test('recordTokenUsage 用 model_rates 的费率而非兜底：改价后新流水按新价记，旧流水不回溯', () => {
    const { db, uid } = makeDb();
    setModelRate(db, 'claude-x', 'in', 0.001, at(-2 * DAY));
    setModelRate(db, 'claude-x', 'out', 0.004, at(-2 * DAY));
    setModelRate(db, 'claude-x', 'cache_read', 0.0001, at(-2 * DAY));
    setModelRate(db, 'claude-x', 'cache_write', 0.00125, at(-2 * DAY));
    const usage = { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 800 };
    recordTokenUsage(uid, 'intake', 'claude-x', usage, 'r-1', null, db);
    // 1 + 2 + 0.2 + 1 = 4.2 公道值 → 4200 厘
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-1'").get()).toEqual({ cost_li: 4200 });

    setModelRate(db, 'claude-x', 'in', 0.002, at(-1 * DAY)); // 输入档涨价
    recordTokenUsage(uid, 'intake', 'claude-x', usage, 'r-2', null, db);
    // 2 + 2 + 0.2 + 1 = 5.2 → 5200 厘；旧流水不被回溯改写
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-2'").get()).toEqual({ cost_li: 5200 });
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='r-1'").get()).toEqual({ cost_li: 4200 });
  });

  test('recordTokenUsage 四列 token 明细分别落库', () => {
    const { db, uid } = makeDb();
    recordTokenUsage(
      uid, 'intake', 'deepseek-x',
      { promptTokens: 11, completionTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, embedTokens: 55 },
      'cols', null, db,
    );
    const row = db.prepare(
      'SELECT prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, embed_tokens FROM token_usage WHERE ref_id=?',
    ).get('cols');
    expect(row).toEqual({
      prompt_tokens: 11, completion_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, embed_tokens: 55,
    });
  });

  test('api_model 落列读回：计费键与厂商回显串各记各的', () => {
    const { db, uid } = makeDb();
    // 计费按 dated 产品名，实际调用发的是别名、厂商回显的是快照串
    recordTokenUsage(uid, 'ocr', 'qwen-vl-ocr-2025-11-20', { promptTokens: 100 }, 'a-1', 'qwen-vl-ocr', db);
    const row = db.prepare("SELECT model, api_model FROM token_usage WHERE ref_id='a-1'").get();
    expect(row).toEqual({ model: 'qwen-vl-ocr-2025-11-20', api_model: 'qwen-vl-ocr' });
  });

  test('api_model 省略时留 NULL（无回显的调用与历史行）', () => {
    const { db, uid } = makeDb();
    recordTokenUsage(uid, 'ocr', 'qwen-vl-ocr-2025-11-20', { promptTokens: 100 }, 'a-2', null, db);
    expect(db.prepare("SELECT api_model FROM token_usage WHERE ref_id='a-2'").get()).toEqual({ api_model: null });
  });

  test('api_model 不参与计价：计费只认 model 这一列', () => {
    const { db, uid } = makeDb();
    setModelRate(db, 'priced-key', 'in', 0.001);
    setModelRate(db, 'echoed-alias', 'in', 999); // 回显串就算配了天价费率也不该被用上
    recordTokenUsage(uid, 'intake', 'priced-key', { promptTokens: 1000 }, 'a-3', 'echoed-alias', db);
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='a-3'").get()).toEqual({ cost_li: 1000 });
  });

  test('DEFAULT_RATES 锚点：DeepSeek-V4-Flash-0731 CNY 高峰价换算（C01 §三，待 M3 核定）', () => {
    expect(DEFAULT_RATES.in).toBeCloseTo(0.0009, 12);        // 3.0 元/MTok
    expect(DEFAULT_RATES.out).toBeCloseTo(0.0027, 12);       // 9.0 元/MTok
    expect(DEFAULT_RATES.cacheRead).toBeCloseTo(0.00003, 12); // 0.10 元/MTok
    expect(DEFAULT_RATES.cacheWrite).toBe(DEFAULT_RATES.in);  // DeepSeek 无缓存写费，兜底取 in 价
  });
});

describe('seedModelRates · C01 费率种子', () => {
  /** 直接读某模型某档的入库费率（不经兜底，缺行即 undefined）。 */
  const rateOf = (db: Database.Database, model: string, kind: string) =>
    (db.prepare('SELECT gongdao_per_token g FROM model_rates WHERE model=? AND token_kind=?')
      .get(model, kind) as { g: number } | undefined)?.g;

  const countRows = (db: Database.Database) =>
    (db.prepare('SELECT COUNT(*) c FROM model_rates').get() as { c: number }).c;

  test('幂等：连跑两遍行数不变，第二遍写入 0 行', () => {
    const { db } = makeDb();
    const first = seedModelRates(db);
    const rows = countRows(db);
    expect(first).toBe(rows);
    expect(rows).toBeGreaterThan(0);

    expect(seedModelRates(db)).toBe(0); // 全部命中 uq_model_rates
    expect(countRows(db)).toBe(rows);
    seedModelRates(db);
    expect(countRows(db)).toBe(rows);
  });

  test('换算锚点：USD 档 = 原价 × 7.20 × 300 / 1e6', () => {
    const { db } = makeDb();
    seedModelRates(db);
    // C01：claude-sonnet-5 输入 $2 → 2×7.2×300/1e6
    expect(rateOf(db, 'claude-sonnet-5', 'in')).toBeCloseTo(0.00432, 12);
    // C01：claude-opus-5 5m 缓存写 $6.25 → 6.25×7.2×300/1e6
    expect(rateOf(db, 'claude-opus-5', 'cache_write')).toBeCloseTo(0.0135, 12);
    // C01：gpt-5.6-luna 缓存读 $0.02 → 0.02×7.2×300/1e6
    expect(rateOf(db, 'gpt-5.6-luna', 'cache_read')).toBeCloseTo(0.0000432, 12);
    // 汇率常量本身也锁死（改汇率必须同时改这条断言，防悄悄漂移）
    expect(USD_CNY_RATE).toBe(7.2);
    expect(GONGDAO_PER_YUAN_TOKEN_COST).toBe(300);
  });

  test('换算锚点：CNY 档 = 原价 × 300 / 1e6（不乘汇率）', () => {
    const { db } = makeDb();
    seedModelRates(db);
    // C01：DeepSeek-V4-Flash-0731 缓存命中 0.10 元（高峰）
    expect(rateOf(db, 'DeepSeek-V4-Flash-0731', 'cache_read')).toBeCloseTo(0.00003, 12);
    // C01：qwen-vl-ocr-2025-11-20 输入 0.3 元
    expect(rateOf(db, 'qwen-vl-ocr-2025-11-20', 'in')).toBeCloseTo(0.00009, 12);
    // C01：text-embedding-v4 输入 0.5 元
    expect(rateOf(db, 'text-embedding-v4', 'in')).toBeCloseTo(0.00015, 12);
    // C01：qwen-max 输出 9.6 元
    expect(rateOf(db, 'qwen-max', 'out')).toBeCloseTo(0.00288, 12);
  });

  test('收录范围：DeepSeek / qwen 系无 cache_write 行；qwen 系无缓存档（C01 待复核项）', () => {
    const { db } = makeDb();
    seedModelRates(db);
    expect(rateOf(db, 'DeepSeek-V4-Flash-0731', 'cache_write')).toBeUndefined();
    for (const kind of ['cache_read', 'cache_write']) {
      expect(rateOf(db, 'qwen-max', kind), `qwen-max 不该有 ${kind} 行`).toBeUndefined();
      expect(rateOf(db, 'qwen-plus:think', kind)).toBeUndefined();
    }
    // text-embedding-v4 只计输入，不该有 out 行
    expect(rateOf(db, 'text-embedding-v4', 'out')).toBeUndefined();
    // 按小时计价的 ASR 不进本表
    expect(rateOf(db, 'paraformer-v2', 'in')).toBeUndefined();
  });

  test('思考/非思考两个变体输出价不同、输入价相同（C01 qwen-plus 第一阶梯）', () => {
    const { db } = makeDb();
    seedModelRates(db);
    expect(rateOf(db, 'qwen-plus:think', 'out')).toBeCloseTo(0.0024, 12);    // 8 元
    expect(rateOf(db, 'qwen-plus:nothink', 'out')).toBeCloseTo(0.0006, 12);  // 2 元
    expect(rateOf(db, 'qwen-plus:think', 'in')).toBe(rateOf(db, 'qwen-plus:nothink', 'in')); // 同为 0.8 元
  });

  test('每行都带 meta_json 出处（源URL/官方原价/币种/汇率/核定日）', () => {
    const { db } = makeDb();
    seedModelRates(db);
    const rows = db.prepare('SELECT model, meta_json FROM model_rates').all() as
      { model: string; meta_json: string | null }[];
    for (const r of rows) {
      expect(r.meta_json, `${r.model} 缺 meta_json`).toBeTruthy();
      const m = JSON.parse(r.meta_json!);
      expect(new Set(Object.keys(m))).toEqual(new Set(['源URL', '官方原价', '币种', '汇率', '核定日']));
      expect(m.源URL).toMatch(/^https:\/\//);
      expect(m.核定日).toBe('2026-08-19');
      expect(typeof m.官方原价).toBe('number');
      expect(m.汇率).toBe(m.币种 === 'USD' ? USD_CNY_RATE : null);
    }
  });

  test('种子模型经 getRatesForModel 可读到（effective_at 已生效，非未来行）', () => {
    const { db } = makeDb();
    seedModelRates(db);
    expect(SEEDED_MODELS.length).toBeGreaterThanOrEqual(10);
    const sonnet = getRatesForModel(db, 'claude-sonnet-5');
    expect(sonnet.in).toBeCloseTo(0.00432, 12);
    expect(sonnet.out).toBeCloseTo(0.0216, 12);       // $10
    expect(sonnet.cacheRead).toBeCloseTo(0.000432, 12); // $0.20
    expect(sonnet.cacheWrite).toBeCloseTo(0.0054, 12);  // $2.50
    // 未收录档位回落兜底：DeepSeek 无缓存写档
    expect(getRatesForModel(db, 'DeepSeek-V4-Flash-0731').cacheWrite).toBe(DEFAULT_RATES.cacheWrite);
  });

  test('种子费率进 recordTokenUsage：claude-sonnet-5 一次调用的 cost_li 手算锚点', () => {
    const { db, uid } = makeDb();
    seedModelRates(db);
    recordTokenUsage(
      uid, 'draft', 'claude-sonnet-5',
      { promptTokens: 10_000, completionTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 8_000 },
      'sonnet-1', null, db,
    );
    // 10000×0.00432 + 2000×0.0216 + 50000×0.000432 + 8000×0.0054
    // = 43.2 + 43.2 + 21.6 + 43.2 = 151.2 公道值 → 151200 厘
    expect(db.prepare("SELECT cost_li FROM token_usage WHERE ref_id='sonnet-1'").get()).toEqual({ cost_li: 151200 });
  });
});
