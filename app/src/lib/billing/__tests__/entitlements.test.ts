// app/src/lib/billing/__tests__/entitlements.test.ts
// 会员赠送券：一单一张（幂等）/ 核销一次 / 退款只作废未核销的 / 核销不写账本 /
// 买会员自动发券的**履约接线**（见文件末尾的 describe）。
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
import { fulfillOrder, reverseOrder, ensureBillingSkus, MEMBERSHIP_SKU_NAME } from '../fulfillment';
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
  // 断的是**集合相等**而不是「包含」：多出一种没人发的券，与少了一种正在用的券，
  // 两件事都得报红。service_extract 今天没有任何发券路径（见 entitlements.ts 的说明），
  // 消费侧在 lib/billing/service-quotes.confirmService。
  test('当前两种券：dossier_core（会员送核心四项一次）与 service_extract（一次内容提取/解读）', () => {
    expect(Object.values(ENTITLEMENT_KIND)).toEqual(['dossier_core', 'service_extract']);
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

// ─────────────────────── 买会员自动发券（履约接线） ───────────────────────
// 「有券怎么用」（consumeEntitlement / confirmDossier）与「券从哪来」（fulfillOrder）
// 是两段路。接上之前，**不接线不会有任何一处报错**——只会让买了月卡的用户发现自己
// 手上并没有那张券，而这件事在系统内部与「本来就不送券」完全同形。
// 所以这一组钉的就是接线本身：把 fulfillment.ts 里那行 grantEntitlement 拿掉，
// 或把 reverseOrder 里那行 revokeUnconsumedBySource 拿掉，本组当场变红。
describe('买会员自动发券', () => {
  const order = (uid: number, skuId: number, orderNo: string) => ({
    user_id: uid,
    order_no: orderNo,
    amount_fen: Math.round(MEMBERSHIP.entry.priceYuan * 100),
    sku_id: skuId,
  });

  test('买月卡即到账一张核心四项券；公道值与会员期照常', () => {
    const { db, uid } = makeDb();
    fulfillOrder(db, order(uid, entrySkuId(db), 'ORD-A'));

    const list = listUnconsumed(db, uid, CORE);
    expect(list).toHaveLength(1);
    expect(list[0].source_ref).toBe('ORD-A'); // 券认得出自己是哪一单送的（退款要按它作废）
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 1 });
  });

  test('重复履约（支付回调重放）仍只有一张券', () => {
    const { db, uid } = makeDb();
    const sku = entrySkuId(db);
    fulfillOrder(db, order(uid, sku, 'ORD-A'));
    fulfillOrder(db, order(uid, sku, 'ORD-A'));

    expect(listUnconsumed(db, uid, CORE)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entitlements').get()).toEqual({ n: 1 });
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao);
  });

  test('续期是一单一张，不是一人一张', () => {
    const { db, uid } = makeDb();
    const sku = entrySkuId(db);
    fulfillOrder(db, order(uid, sku, 'ORD-A'));
    fulfillOrder(db, order(uid, sku, 'ORD-B'));
    expect(listUnconsumed(db, uid, CORE).map((e) => e.source_ref)).toEqual(['ORD-A', 'ORD-B']);
  });

  test('散充不发券（券是会员权益，不是充值赠品）', () => {
    const { db, uid } = makeDb();
    const sku = (db.prepare('SELECT id FROM skus WHERE name=?').get('散充·10元') as { id: number }).id;
    fulfillOrder(db, { user_id: uid, order_no: 'ORD-R', amount_fen: 1000, sku_id: sku });
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0);
  });

  test('退单：本单未核销的券被作废，之后核销不到', () => {
    const { db, uid } = makeDb();
    const o = order(uid, entrySkuId(db), 'ORD-A');
    fulfillOrder(db, o);
    reverseOrder(db, o);

    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0);
    expect(consumeEntitlement(db, uid, CORE, 'dossier-1')).toBeNull();
  });

  test('退单不追回已核销的券：档案已交付，它得留着解释自己为什么没扣钱', () => {
    const { db, uid } = makeDb();
    const o = order(uid, entrySkuId(db), 'ORD-A');
    fulfillOrder(db, o);
    const usedId = consumeEntitlement(db, uid, CORE, 'dossier-9');
    reverseOrder(db, o);

    const row = db.prepare('SELECT consumed_ref, revoked_at FROM entitlements WHERE id=?').get(usedId) as {
      consumed_ref: string | null;
      revoked_at: string | null;
    };
    expect(row.consumed_ref).toBe('dossier-9');
    expect(row.revoked_at).toBeNull();
  });

  test('退完再重放履约不会补发一张（发券幂等键是订单号，退款不解锁它）', () => {
    const { db, uid } = makeDb();
    const o = order(uid, entrySkuId(db), 'ORD-A');
    fulfillOrder(db, o);
    reverseOrder(db, o);
    fulfillOrder(db, o);
    expect(listUnconsumed(db, uid, CORE)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entitlements').get()).toEqual({ n: 1 });
  });
});
