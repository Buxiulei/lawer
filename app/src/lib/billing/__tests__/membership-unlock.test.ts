// app/src/lib/billing/__tests__/membership-unlock.test.ts
// 中/高档会员解封暗启（spec v3 §7.1/A2）：SKU 可售与否由 flag LAWER_MEMBERSHIP_TIERS_UNLOCKED
// 决定，**默认关**。entry 始终可售，standard/pro 关时下架、开时上架。
//
// 【变异核】两个方向各钉一根：默认关必须下架、显式开必须上架。
// 把 enabled 写死 1（无视 flag）会让「默认关」那组红；写死 0 会让「显式开」那组红——
// 任何一侧的偷懒实现都逃不过。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../../db/migrate';
import {
  MEMBERSHIP_SKU_NAME,
  MEMBERSHIP_TIERS_UNLOCKED_ENV,
  assertSkuSellable,
  ensureBillingSkus,
  membershipTiersUnlocked,
} from '../fulfillment';

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const skuId = (db: Database.Database, name: string) =>
  (db.prepare('SELECT id FROM skus WHERE name=?').get(name) as { id: number }).id;

const enabledOf = (db: Database.Database, name: string) =>
  (db.prepare('SELECT enabled FROM skus WHERE name=?').get(name) as { enabled: number }).enabled;

// 每个用例前后都把这个 env 清干净：默认状态就是"没配"，且不许泄到别的测试文件。
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV];
  delete process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV];
  else process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = saved;
});

describe('membershipTiersUnlocked flag 读取', () => {
  test('未配置 = 关（暗启默认关）', () => {
    expect(membershipTiersUnlocked()).toBe(false);
  });

  test('只有显式真值（1/true/yes/on，大小写不敏感）才算开', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On']) {
      process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = v;
      expect(membershipTiersUnlocked(), `「${v}」应判为开`).toBe(true);
    }
  });

  test('配了但不是真值（0/false/空串/随便）一律当关——半配置宁可严', () => {
    for (const v of ['0', 'false', '', '  ', 'off', 'no', 'later']) {
      process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = v;
      expect(membershipTiersUnlocked(), `「${v}」应判为关`).toBe(false);
    }
  });
});

describe('D4 · 默认关：中/高档下架、entry 始终可售', () => {
  test('flag 未配：standard/pro enabled=0，assertSkuSellable 抛「下架」，entry 正常', () => {
    const db = newDb();
    ensureBillingSkus(db);

    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.entry)).toBe(1);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.standard)).toBe(0);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.pro)).toBe(0);

    expect(() => assertSkuSellable(db, skuId(db, MEMBERSHIP_SKU_NAME.entry))).not.toThrow();
    expect(() => assertSkuSellable(db, skuId(db, MEMBERSHIP_SKU_NAME.standard))).toThrow(/下架/);
    expect(() => assertSkuSellable(db, skuId(db, MEMBERSHIP_SKU_NAME.pro))).toThrow(/下架/);
  });

  test('flag 配成非真值（0）仍然关', () => {
    process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = '0';
    const db = newDb();
    ensureBillingSkus(db);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.standard)).toBe(0);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.pro)).toBe(0);
  });
});

describe('D4 · 解封开：中/高档上架可售', () => {
  test('flag=1：standard/pro enabled=1，assertSkuSellable 全放行，entry 仍可售', () => {
    process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = '1';
    const db = newDb();
    ensureBillingSkus(db);

    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.entry)).toBe(1);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.standard)).toBe(1);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.pro)).toBe(1);

    expect(() => assertSkuSellable(db, skuId(db, MEMBERSHIP_SKU_NAME.standard))).not.toThrow();
    expect(() => assertSkuSellable(db, skuId(db, MEMBERSHIP_SKU_NAME.pro))).not.toThrow();
  });

  test('翻回关（重跑 ensureBillingSkus）即重新下架——enabled 随 flag 每次开库重算', () => {
    process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV] = '1';
    const db = newDb();
    ensureBillingSkus(db);
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.pro)).toBe(1);

    delete process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV];
    ensureBillingSkus(db); // 幂等 upsert：同一行按 name 重算 enabled
    expect(enabledOf(db, MEMBERSHIP_SKU_NAME.pro)).toBe(0);
  });
});
