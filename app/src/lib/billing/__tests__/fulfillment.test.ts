// app/src/lib/billing/__tests__/fulfillment.test.ts
// 订单履约（钱的地基·消费端）：SKU 语义、套餐/散充入账、回调幂等、续期叠加、退款核销、SKU 种子。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import {
  ensureBillingSkus,
  resolveSkuKind,
  fulfillOrder,
  reverseOrder,
  grantMembership,
  getMembership,
  MEMBERSHIP_SKU_NAME,
  CUSTOM_RECHARGE_SKU_NAME,
} from '../fulfillment';
import { getGongdao, gongdaoGrant, gongdaoSettle } from '../index';
import { MEMBERSHIP, GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO, rechargeGongdao } from '../pricing';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  ensureBillingSkus(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid,
  );
  return { db, uid };
}

const skuId = (db: Database.Database, name: string) =>
  (db.prepare('SELECT id FROM skus WHERE name=?').get(name) as { id: number }).id;

const ledgerSum = (db: Database.Database, uid: number) =>
  (db.prepare('SELECT COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE user_id=?').get(uid) as { s: number }).s;

function insertOrder(db: Database.Database, orderNo: string, uid: number, skuName: string, amountFen: number) {
  db.prepare("INSERT INTO orders (order_no,user_id,sku_id,amount_fen,gongdao,status) VALUES (?,?,?,?,?,'pending')")
    .run(orderNo, uid, skuId(db, skuName), amountFen, 0);
}

/** 模拟支付回调：pending→credited 守卫 + 履约。 */
function payCallback(db: Database.Database, orderNo: string) {
  const order = db.prepare('SELECT user_id, sku_id, amount_fen FROM orders WHERE order_no=?').get(orderNo) as
    { user_id: number; sku_id: number; amount_fen: number };
  db.transaction(() => {
    const res = db.prepare("UPDATE orders SET status='credited' WHERE order_no=? AND status='pending'").run(orderNo);
    if (res.changes > 0) {
      fulfillOrder(db, { user_id: order.user_id, order_no: orderNo, amount_fen: order.amount_fen, sku_id: order.sku_id });
    }
  })();
}

describe('ensureBillingSkus 种子', () => {
  test('种入三档月卡 + 固定散充面额 + 自定义散充占位行，重复调用幂等', () => {
    const { db } = makeDb();
    ensureBillingSkus(db); // 二次调用应幂等
    const read = (name: string) =>
      db.prepare('SELECT gongdao, price_fen, enabled FROM skus WHERE name=?').get(name) as
        { gongdao: number; price_fen: number; enabled: number };
    expect(read(MEMBERSHIP_SKU_NAME.entry)).toEqual({ gongdao: 3000, price_fen: 1990, enabled: 1 });
    expect(read(MEMBERSHIP_SKU_NAME.standard)).toEqual({ gongdao: 9000, price_fen: 5900, enabled: 1 });
    expect(read(MEMBERSHIP_SKU_NAME.pro)).toEqual({ gongdao: 30000, price_fen: 19900, enabled: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM skus WHERE name LIKE '散充·%元' AND enabled=1").get()).toEqual({ c: 3 });
    // 自定义散充是内部挂靠行：不对外展示
    expect(read(CUSTOM_RECHARGE_SKU_NAME)).toEqual({ gongdao: 0, price_fen: 0, enabled: 0 });
    // 幂等：SKU 总数不随重复调用增长
    expect(db.prepare('SELECT COUNT(*) c FROM skus').get()).toEqual({ c: 7 });
  });
});

describe('resolveSkuKind SKU 语义', () => {
  test('三档套餐名 → membership；其余 → recharge；SKU 缺失 → recharge', () => {
    const { db } = makeDb();
    expect(resolveSkuKind(db, skuId(db, MEMBERSHIP_SKU_NAME.entry))).toEqual({ kind: 'membership', plan: 'entry' });
    expect(resolveSkuKind(db, skuId(db, MEMBERSHIP_SKU_NAME.standard))).toEqual({ kind: 'membership', plan: 'standard' });
    expect(resolveSkuKind(db, skuId(db, MEMBERSHIP_SKU_NAME.pro))).toEqual({ kind: 'membership', plan: 'pro' });
    expect(resolveSkuKind(db, skuId(db, '散充·30元'))).toEqual({ kind: 'recharge' });
    expect(resolveSkuKind(db, skuId(db, CUSTOM_RECHARGE_SKU_NAME))).toEqual({ kind: 'recharge' });
    expect(resolveSkuKind(db, 99999)).toEqual({ kind: 'recharge' }); // 不存在
  });
});

describe('fulfillOrder 履约', () => {
  test('散充：按实付金额 ×100 入公道值（充值类流水）', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'R1', uid, '散充·30元', 3000);
    payCallback(db, 'R1');
    expect(getGongdao(uid, db)).toBe(rechargeGongdao(30)); // 3000
    const row = db.prepare("SELECT type FROM gongdao_ledger WHERE ref_id='R1'").get() as { type: string };
    expect(row.type).toBe(GONGDAO_LEDGER_TYPE.recharge);
  });

  test('自定义散充：挂靠 SKU + 任意金额，按实付计', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'R2', uid, CUSTOM_RECHARGE_SKU_NAME, 8800); // 88 元
    payCallback(db, 'R2');
    expect(getGongdao(uid, db)).toBe(8800);
  });

  test('入门套餐：入 3000 公道值（会员额度）+ 30 天会员期', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'M1', uid, MEMBERSHIP_SKU_NAME.entry, 1990);
    payCallback(db, 'M1');
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao);
    const status = getMembership(db, uid);
    expect(status.active).toBe(true);
    expect(status.plan).toBe('entry');
    const row = db.prepare("SELECT type FROM gongdao_ledger WHERE ref_id='M1'").get() as { type: string };
    expect(row.type).toBe(GONGDAO_LEDGER_TYPE.membership);
  });

  test('高配套餐：入 30000 公道值 + 30 天', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'P1', uid, MEMBERSHIP_SKU_NAME.pro, 19900);
    payCallback(db, 'P1');
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.pro.gongdao);
    expect(getMembership(db, uid).plan).toBe('pro');
  });

  test('套餐回调重放：同 orderNo 两次只入账一次、只开一次会员期', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'M1', uid, MEMBERSHIP_SKU_NAME.standard, 5900);
    payCallback(db, 'M1');
    payCallback(db, 'M1'); // 重放
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.standard.gongdao);
    expect(ledgerSum(db, uid)).toBe(MEMBERSHIP.standard.gongdao);
    expect(db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id='M1'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM memberships WHERE order_no='M1'").get()).toEqual({ c: 1 });
  });

  test('散充回调重放：同 orderNo 两次只入账一次', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'R1', uid, '散充·50元', 5000);
    payCallback(db, 'R1');
    payCallback(db, 'R1'); // 重放
    expect(getGongdao(uid, db)).toBe(5000);
    expect(db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id='R1'").get()).toEqual({ c: 1 });
  });

  test('直接二次 fulfillOrder（无状态守卫）仍幂等（ledger + memberships 唯一索引兜底）', () => {
    const { db, uid } = makeDb();
    const order = { user_id: uid, order_no: 'M1', amount_fen: 5900, sku_id: skuId(db, MEMBERSHIP_SKU_NAME.standard) };
    fulfillOrder(db, order);
    fulfillOrder(db, order);
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.standard.gongdao);
    expect(db.prepare('SELECT COUNT(*) c FROM memberships WHERE user_id=?').get(uid)).toEqual({ c: 1 });
  });
});

describe('套餐续期叠加', () => {
  test('两笔月卡（不同 orderNo）：公道值累加，会员期叠加 30 天', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'M1', uid, MEMBERSHIP_SKU_NAME.entry, 1990);
    insertOrder(db, 'M2', uid, MEMBERSHIP_SKU_NAME.entry, 1990);
    payCallback(db, 'M1');
    const first = getMembership(db, uid).expiresAt!;
    payCallback(db, 'M2');
    const second = getMembership(db, uid).expiresAt!;

    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao * 2);
    const gapDays = (new Date(second + 'Z').getTime() - new Date(first + 'Z').getTime()) / 86400000;
    expect(Math.round(gapDays)).toBe(30); // 续期叠加，非覆盖
    expect(db.prepare('SELECT COUNT(*) c FROM memberships WHERE user_id=?').get(uid)).toEqual({ c: 2 });
  });

  test('grantMembership 同 orderNo 幂等：第二次返回 false 不叠加', () => {
    const { db, uid } = makeDb();
    expect(grantMembership(db, uid, 'entry', 'M1')).toBe(true);
    expect(grantMembership(db, uid, 'entry', 'M1')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM memberships WHERE user_id=?').get(uid)).toEqual({ c: 1 });
  });
});

describe('reverseOrder 退款核销', () => {
  test('套餐订单退款：会员期删除、公道值负记核销、重复 reverse 不双扣', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'M1', uid, MEMBERSHIP_SKU_NAME.pro, 19900);
    payCallback(db, 'M1');
    const order = { user_id: uid, order_no: 'M1', amount_fen: 19900, sku_id: skuId(db, MEMBERSHIP_SKU_NAME.pro) };

    reverseOrder(db, order);
    reverseOrder(db, order); // 重放：writeoff-<orderNo> 唯一索引挡下
    expect(getGongdao(uid, db)).toBe(0);
    expect(ledgerSum(db, uid)).toBe(0);
    expect(getMembership(db, uid).active).toBe(false);
    const writeoff = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE type=?')
      .get(GONGDAO_LEDGER_TYPE.writeoff) as { c: number; s: number };
    expect(writeoff).toEqual({ c: 1, s: -MEMBERSHIP.pro.gongdao });
    expect(db.prepare("SELECT COUNT(*) c FROM memberships WHERE order_no='M1'").get()).toEqual({ c: 0 });
  });

  test('用户已花掉套餐额度后退款：核销仍按实际入账额，余额被打入负（透支由 gate 拦）', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'M1', uid, MEMBERSHIP_SKU_NAME.entry, 1990);
    payCallback(db, 'M1');
    gongdaoSettle(uid, 2500, 'intake-9', 'intake', db); // 花掉大半
    reverseOrder(db, { user_id: uid, order_no: 'M1', amount_fen: 1990, sku_id: skuId(db, MEMBERSHIP_SKU_NAME.entry) });
    expect(getGongdao(uid, db)).toBe(MEMBERSHIP.entry.gongdao - 2500 - MEMBERSHIP.entry.gongdao);
    expect(ledgerSum(db, uid)).toBe(-2500);
  });

  test('散充订单退款：按实际入账精确回收', () => {
    const { db, uid } = makeDb();
    insertOrder(db, 'R1', uid, '散充·10元', 1000);
    payCallback(db, 'R1');
    reverseOrder(db, { user_id: uid, order_no: 'R1', amount_fen: 1000, sku_id: skuId(db, '散充·10元') });
    expect(getGongdao(uid, db)).toBe(0);
    expect(ledgerSum(db, uid)).toBe(0);
  });

  test('未履约订单 reverse：无正向入账可核销，不写任何行', () => {
    const { db, uid } = makeDb();
    reverseOrder(db, { user_id: uid, order_no: 'NOPE', amount_fen: 1000, sku_id: skuId(db, '散充·10元') });
    expect(ledgerSum(db, uid)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });
  });
});

describe('注册赠送', () => {
  test('gongdaoGrant(注册赠送, reg-<uid>) 幂等：重复赠送只入一次定额', () => {
    const { db, uid } = makeDb();
    expect(REGISTER_GRANT_GONGDAO).toBe(1000);
    expect(gongdaoGrant(uid, REGISTER_GRANT_GONGDAO, GONGDAO_LEDGER_TYPE.register, `reg-${uid}`, null, db)).toBe(true);
    expect(gongdaoGrant(uid, REGISTER_GRANT_GONGDAO, GONGDAO_LEDGER_TYPE.register, `reg-${uid}`, null, db)).toBe(false);
    expect(getGongdao(uid, db)).toBe(REGISTER_GRANT_GONGDAO);
  });
});
