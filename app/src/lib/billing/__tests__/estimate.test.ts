// app/src/lib/billing/__tests__/estimate.test.ts
// 公道值预检估算器行为锁死：定额端点直返 / 种子回落（样本不足）/ P90 十位取整（样本充足）/
// feature 精确匹配 / 零成本行排除 / ensureGongdaoFor（够 / 缺口 / 恰好等于 / 负余额）。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { gongdaoGrant, gongdaoSettle } from '../index';
import { GONGDAO_LEDGER_TYPE } from '../pricing';
import {
  estimateGongdao,
  ensureGongdaoFor,
  SEED,
  SEED_DEFAULT,
  FIXED_PRICING,
  KNOWN_ESTIMATE_FEATURES,
} from '../estimate';
import { KNOWN_FEATURE_KEYS } from '../features';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid,
  );
  return { db, uid };
}

/** 插 n 笔某 feature 的消耗流水（各 amount 公道值，ref 唯一）。 */
function seedConsumption(db: Database.Database, uid: number, feature: string, amounts: number[]) {
  amounts.forEach((amt, i) => gongdaoSettle(uid, amt, `${feature}-ref-${i}`, feature, db));
}

describe('estimateGongdao · 定额端点', () => {
  test('attest / export 直返定额，不走 P90（即使历史流水很多）', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    seedConsumption(db, uid, 'attest', Array(30).fill(9999)); // 大量历史也不影响定额
    expect(estimateGongdao(db, 'attest')).toEqual({ gongdao: FIXED_PRICING.attest, basis: 'seed', sampleN: 0 });
    expect(estimateGongdao(db, 'export')).toEqual({ gongdao: FIXED_PRICING.export, basis: 'seed', sampleN: 0 });
    expect(FIXED_PRICING.attest).toBe(2000);
    expect(FIXED_PRICING.export).toBe(1000);
  });
});

describe('estimateGongdao · 种子回落（样本不足 / 零历史）', () => {
  test('零历史 → 该 feature 的 SEED，basis=seed，sampleN=0', () => {
    const { db } = makeDb();
    expect(estimateGongdao(db, 'draft')).toEqual({ gongdao: SEED.draft, basis: 'seed', sampleN: 0 });
    expect(SEED.draft).toBe(400);
  });

  test('未登记 feature 零历史 → SEED_DEFAULT=300', () => {
    const { db } = makeDb();
    expect(estimateGongdao(db, 'unknown_feature')).toEqual({ gongdao: SEED_DEFAULT, basis: 'seed', sampleN: 0 });
    expect(SEED_DEFAULT).toBe(300);
  });

  test('MIN_SAMPLE 边界：7 笔 → 种子（sampleN=7）；第 8 笔起转历史', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    seedConsumption(db, uid, 'ocr', Array(7).fill(80));
    expect(estimateGongdao(db, 'ocr')).toEqual({ gongdao: SEED.ocr, basis: 'seed', sampleN: 7 });

    gongdaoSettle(uid, 80, 'ocr-ref-7', 'ocr', db); // 第 8 笔
    const at8 = estimateGongdao(db, 'ocr');
    expect(at8.basis).toBe('history');
    expect(at8.sampleN).toBe(8);
    expect(at8.gongdao).toBe(80); // 全 80 → P90=80 → 十位取整仍 80
  });
});

describe('estimateGongdao · 历史 P90（样本充足）', () => {
  test('45×100 + 5×900（n=50）→ P90=900，basis=history，sampleN=50', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    seedConsumption(db, uid, 'intake', [...Array(45).fill(100), ...Array(5).fill(900)]);
    expect(estimateGongdao(db, 'intake')).toEqual({ gongdao: 900, basis: 'history', sampleN: 50 });
  });

  test('十位取整：P90 落在 29 → 向上取整到 30', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    // 20 笔 = 11..30；n=20 → P90 index=ceil(0.9*19)=18 → sorted[18]=29 → ceilTo10=30。
    seedConsumption(db, uid, 'companion', Array.from({ length: 20 }, (_, i) => 11 + i));
    const est = estimateGongdao(db, 'companion');
    expect(est).toEqual({ gongdao: 30, basis: 'history', sampleN: 20 });
  });

  test('仅取最近 RECENT_N=50 笔：插 60 笔，sampleN 封顶 50', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 10_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    seedConsumption(db, uid, 'asr', Array(60).fill(300));
    expect(estimateGongdao(db, 'asr')).toEqual({ gongdao: 300, basis: 'history', sampleN: 50 });
  });
});

describe('estimateGongdao · feature 精确匹配 + 零成本行排除', () => {
  test('feature 隔离：intake 有流水不污染 draft（后者仍走种子）', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1_000_000, GONGDAO_LEDGER_TYPE.membership, 'seed-bal', null, db);
    seedConsumption(db, uid, 'intake', Array(20).fill(900));
    expect(estimateGongdao(db, 'draft')).toEqual({ gongdao: SEED.draft, basis: 'seed', sampleN: 0 });
    expect(estimateGongdao(db, 'intake').basis).toBe('history');
  });

  test('cost=0 的零成本 / 幂等标记行（delta=0）被排除，不计入样本', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db);
    for (let i = 0; i < 10; i++) gongdaoSettle(uid, 0, `intake-zero-${i}`, 'intake', db);
    expect(estimateGongdao(db, 'intake')).toEqual({ gongdao: SEED.intake, basis: 'seed', sampleN: 0 });
  });
});

describe('ensureGongdaoFor · 服务端 gate（余额 ≥ 预计）', () => {
  test('余额 > 预计 → ok:true，回带 estimate/balance', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 1000, GONGDAO_LEDGER_TYPE.membership, 'g', null, db);
    expect(ensureGongdaoFor(db, uid, 'draft')).toEqual({ ok: true, estimate: 400, balance: 1000 });
  });

  test('恰好等于（balance == estimate）→ ok:true（>= 边界含等号）', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 400, GONGDAO_LEDGER_TYPE.membership, 'g', null, db);
    expect(ensureGongdaoFor(db, uid, 'draft')).toEqual({ ok: true, estimate: 400, balance: 400 });
  });

  test('余额 < 预计 → ok:false，shortfall 精确 = estimate - balance', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.membership, 'g', null, db);
    expect(ensureGongdaoFor(db, uid, 'draft')).toEqual({ ok: false, estimate: 400, balance: 100, shortfall: 300 });
  });

  test('负余额（末单透支入负）→ ok:false，shortfall = estimate + |负余额|', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 5, GONGDAO_LEDGER_TYPE.register, null, null, db);
    gongdaoSettle(uid, 23, 'last', 'intake', db); // 余额 → -18
    expect(ensureGongdaoFor(db, uid, 'intake')).toEqual({
      ok: false, estimate: SEED.intake, balance: -18, shortfall: SEED.intake + 18,
    });
  });

  test('无 gongdao 行（余额视作 0）→ ok:false，shortfall = 预计', () => {
    const { db, uid } = makeDb();
    expect(ensureGongdaoFor(db, uid, 'attest')).toEqual({
      ok: false, estimate: FIXED_PRICING.attest, balance: 0, shortfall: FIXED_PRICING.attest,
    });
  });
});

describe('feature 键表一致性', () => {
  /** 已登记标签但只记量不扣费的键：不进估算白名单（无从估、也无须预检余额）。 */
  const METERED_ONLY_FEATURES = ['companywatch']; // 扣费口径待 M3，届时移出本表并补 SEED

  test('KNOWN_ESTIMATE_FEATURES 恰为 features.ts 登记键去掉只记量不扣费的那些（同一词表，不许分叉）', () => {
    const chargeable = KNOWN_FEATURE_KEYS.filter((k) => !METERED_ONLY_FEATURES.includes(k));
    expect([...KNOWN_ESTIMATE_FEATURES].sort()).toEqual(chargeable.sort());
    expect(KNOWN_ESTIMATE_FEATURES.length).toBe(8);
    // 只记量的键必须已登记标签——用量明细照样要出中文
    for (const f of METERED_ONLY_FEATURES) expect(KNOWN_FEATURE_KEYS).toContain(f);
  });

  test('每个可估算 feature 要么有 SEED 要么有 FIXED_PRICING（不靠兜底默认值蒙混）', () => {
    for (const f of KNOWN_ESTIMATE_FEATURES) {
      expect(SEED[f] ?? FIXED_PRICING[f], `feature「${f}」既无种子也无定额`).toBeDefined();
    }
  });
});
