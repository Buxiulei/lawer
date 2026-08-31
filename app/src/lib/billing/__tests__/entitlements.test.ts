// app/src/lib/billing/__tests__/entitlements.test.ts
// 会员赠送券：一单一张（幂等）/ 核销一次 / 退款只作废未核销的 / 核销不写账本 /
// 「发券还没接进履约」这条缺口有路标钉着（见文件末尾的 describe）。
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import {
  ENTITLEMENT_KIND,
  consumeEntitlement,
  grantEntitlement,
  listUnconsumed,
  revokeUnconsumedBySource,
} from '../entitlements';
import { fulfillOrder, ensureBillingSkus, MEMBERSHIP_SKU_NAME } from '../fulfillment';
import { MEMBERSHIP } from '../pricing';
import { getGongdao } from '../index';

const CORE = ENTITLEMENT_KIND.dossierCore;

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  ensureBillingSkus(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  return { db, uid, other };
}

function entrySkuId(db: Database.Database): number {
  return (db.prepare('SELECT id FROM skus WHERE name=?').get(MEMBERSHIP_SKU_NAME.entry) as { id: number }).id;
}

function ledgerRows(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n;
}

describe('券种值域', () => {
  test('当前只有一种券 dossier_core（买会员送核心四项一次，深度模块不覆盖）', () => {
    expect(Object.values(ENTITLEMENT_KIND)).toEqual(['dossier_core']);
    expect(CORE).toBe('dossier_core');
  });
});

describe('发券幂等', () => {
  test('同一 source_ref 重复发只有一张（支付回调重放不多送）', () => {
    const { db, uid } = makeDb();
    expect(grantEntitlement(db, uid, CORE, 'ord-1')).toBe(true);
    expect(grantEntitlement(db, uid, CORE, 'ord-1')).toBe(false);
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entitlements').get()).toEqual({ n: 1 });
  });

  test('不同订单各一张；不同用户互不可见', () => {
    const { db, uid, other } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    grantEntitlement(db, uid, CORE, 'ord-2');
    grantEntitlement(db, other, CORE, 'ord-3');
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(2);
    expect(listUnconsumed(db, other, CORE)).toHaveLength(1);
  });

  test('先发先用：列表按发放顺序（用户不必自己挑哪张先用）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    grantEntitlement(db, uid, CORE, 'ord-2');
    const list = listUnconsumed(db, uid, CORE);
    expect(list.map((e) => e.source_ref)).toEqual(['ord-1', 'ord-2']);
    expect(list[0].id).toBeLessThan(list[1].id);
  });
});

describe('核销', () => {
  test('核销一次即消失于未核销清单，并留下去向', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    const id = consumeEntitlement(db, uid, CORE, 'dossier-7');
    expect(id).not.toBeNull();
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0);
    const row = db.prepare('SELECT consumed_at, consumed_ref FROM entitlements WHERE id=?').get(id) as {
      consumed_at: string | null;
      consumed_ref: string | null;
    };
    expect(row.consumed_at).toBeTruthy();
    expect(row.consumed_ref).toBe('dossier-7');
  });

  test('两张券连核销两次拿到两个不同 id；用完返回 null', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    grantEntitlement(db, uid, CORE, 'ord-2');
    const a = consumeEntitlement(db, uid, CORE, 'dossier-1');
    const b = consumeEntitlement(db, uid, CORE, 'dossier-2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(consumeEntitlement(db, uid, CORE, 'dossier-3')).toBeNull();
  });

  test('一张券只能用一次：连着核销两回，第二回没得可用（不双花）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    expect(consumeEntitlement(db, uid, CORE, 'dossier-1')).not.toBeNull();
    expect(consumeEntitlement(db, uid, CORE, 'dossier-2')).toBeNull();
    // 已核销那张的去向不被第二次尝试改写
    const row = db.prepare("SELECT consumed_ref FROM entitlements WHERE source_ref='ord-1'").get() as {
      consumed_ref: string;
    };
    expect(row.consumed_ref).toBe('dossier-1');
  });

  test('核销**不写账本**：ledger 行数与余额完全不变（ledger 只记钱）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    const before = { rows: ledgerRows(db), balance: getGongdao(uid, db) };
    consumeEntitlement(db, uid, CORE, 'dossier-1');
    expect({ rows: ledgerRows(db), balance: getGongdao(uid, db) }).toEqual(before);
  });

  test('别人的券核销不到', () => {
    const { db, uid, other } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    expect(consumeEntitlement(db, other, CORE, 'dossier-1')).toBeNull();
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(1);
  });

  test('已作废的券核销不到（退过款的会员不该还能换一次档）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    revokeUnconsumedBySource(db, CORE, 'ord-1');
    expect(consumeEntitlement(db, uid, CORE, 'dossier-1')).toBeNull();
  });
});

describe('作废（订单退款）', () => {
  test('只作废未核销的；已核销的不追回', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-used');
    grantEntitlement(db, uid, CORE, 'ord-free');
    const usedId = consumeEntitlement(db, uid, CORE, 'dossier-1');

    expect(revokeUnconsumedBySource(db, CORE, 'ord-used')).toBe(0);
    expect(revokeUnconsumedBySource(db, CORE, 'ord-free')).toBe(1);

    const used = db.prepare('SELECT consumed_at, revoked_at FROM entitlements WHERE id=?').get(usedId) as {
      consumed_at: string | null;
      revoked_at: string | null;
    };
    expect(used.consumed_at).toBeTruthy();
    expect(used.revoked_at).toBeNull(); // 货已交付，不追回
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0);
  });

  test('重复作废幂等（第二次影响 0 行）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    expect(revokeUnconsumedBySource(db, CORE, 'ord-1')).toBe(1);
    expect(revokeUnconsumedBySource(db, CORE, 'ord-1')).toBe(0);
  });

  test('只动这一单的券：别的订单发的券一张不碰', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, CORE, 'ord-1');
    grantEntitlement(db, uid, CORE, 'ord-2');
    expect(revokeUnconsumedBySource(db, CORE, 'ord-1')).toBe(1);
    expect(listUnconsumed(db, uid, CORE).map((e) => e.source_ref)).toEqual(['ord-2']);
  });
});

// ─────────────────────── 缺口路标：发券还没接进订单履约 ───────────────────────
// 本分支交付的是「有券怎么用」（consumeEntitlement / confirmDossier），**没有接**
// 「买了会员就发一张券」那一步：fulfillOrder 里没有 grantEntitlement，reverseOrder 里
// 没有 revokeUnconsumedBySource。entitlements.ts 的注释写的是「应在调用方履约事务内调用」，
// 那句话描述的是设计意图，不是现状。
//
// 【为什么把缺口写成测试，而不是记在待办里】「等某人接线」这种待办，在外部看来与
// 「本来就没这条任务」完全同形——没接线不会有任何一处报错，只会让买了月卡的用户
// 发现自己并没有那张券。写成断言，接线的人一改代码这条就红，红的同时读到这段话，
// 知道该把它改成正向断言（buy → listUnconsumed 有一张；退款 → 被作废）。
//
// 配一条正向臂：证明「一张券确实能被发出来、能被用」，免得这个 describe 整体退化成
// 「什么都没实现所以什么都对」。
describe('⚠️ 已知缺口：买会员尚未自动发券（接线时把本组改成正向断言）', () => {
  const order = (uid: number, skuId: number, orderNo: string) => ({
    user_id: uid,
    order_no: orderNo,
    amount_fen: Math.round(MEMBERSHIP.entry.priceYuan * 100),
    sku_id: skuId,
  });

  test('当前：买月卡不发券（原有的公道值与会员期履约照常，未被本分支破坏）', () => {
    const { db, uid } = makeDb();
    const sku = entrySkuId(db);
    fulfillOrder(db, order(uid, sku, 'ORD-A'));
    fulfillOrder(db, order(uid, sku, 'ORD-A')); // 重复履约仍幂等

    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0); // ← 接线后这里应为 1
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 1 });
  });

  test('正向臂：券这条路本身是通的——手工发一张就能列出来、能核销', () => {
    const { db, uid } = makeDb();
    expect(grantEntitlement(db, uid, CORE, 'ORD-MANUAL')).toBe(true);
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(1);
    expect(consumeEntitlement(db, uid, CORE, 'dossier-1')).not.toBeNull();
  });
});
