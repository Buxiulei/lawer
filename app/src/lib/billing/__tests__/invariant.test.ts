// app/src/lib/billing/__tests__/invariant.test.ts
// 账本不变量核验（钱！最高标准）——跨函数、跨用户的整体一致性锁死。
// 铁律：gongdao_ledger 是唯一事实源，gongdao.balance 恒等于其 delta 之和。任何入账/结算/退款/
// 履约/核销/兑换/管理员调整之后，对全体用户重算此不变量都必须成立；同 ref 重放绝不双记。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import {
  getGongdao,
  gongdaoGate,
  gongdaoGrant,
  gongdaoSettle,
  gongdaoRefund,
  adminAdjustGongdao,
  recordTokenUsage,
} from '../index';
import {
  ensureBillingSkus,
  fulfillOrder,
  reverseOrder,
  getMembership,
  MEMBERSHIP_SKU_NAME,
} from '../fulfillment';
import { redeemCode } from '../redeem';
import {
  GONGDAO_LEDGER_TYPE,
  MEMBERSHIP,
  DEFAULT_RATES,
  costOfUsage,
  exactGongdaoOfUsage,
  rechargeGongdao,
} from '../pricing';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  ensureBillingSkus(db);
  return db;
}

function addUser(db: Database.Database, email: string): number {
  return Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
}

const skuId = (db: Database.Database, name: string) =>
  (db.prepare('SELECT id FROM skus WHERE name=?').get(name) as { id: number }).id;

function insertOrder(db: Database.Database, orderNo: string, uid: number, skuName: string, amountFen: number) {
  db.prepare("INSERT INTO orders (order_no,user_id,sku_id,amount_fen,gongdao,status) VALUES (?,?,?,?,?,'pending')")
    .run(orderNo, uid, skuId(db, skuName), amountFen, 0);
}

/** 模拟支付回调：pending→credited 守卫 + 履约。 */
function payCallback(db: Database.Database, orderNo: string) {
  const o = db.prepare('SELECT user_id, sku_id, amount_fen FROM orders WHERE order_no=?').get(orderNo) as
    { user_id: number; sku_id: number; amount_fen: number };
  db.transaction(() => {
    const res = db.prepare("UPDATE orders SET status='credited' WHERE order_no=? AND status='pending'").run(orderNo);
    if (res.changes > 0) {
      fulfillOrder(db, { user_id: o.user_id, order_no: orderNo, amount_fen: o.amount_fen, sku_id: o.sku_id });
    }
  })();
}

/**
 * 全局不变量：凡在 gongdao 或 gongdao_ledger 出现过的 user，其 balance 必恒等于该 user 的 delta 之和。
 * 返回被核验的 user 数（用于确认样本非空，防「零断言假绿」）。
 */
function assertGlobalInvariant(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT u.user_id AS uid,
           COALESCE(g.balance, 0) AS balance,
           COALESCE(l.s, 0) AS ledger_sum
      FROM (SELECT user_id FROM gongdao UNION SELECT user_id FROM gongdao_ledger) u
      LEFT JOIN gongdao g ON g.user_id = u.user_id
      LEFT JOIN (SELECT user_id, SUM(delta) s FROM gongdao_ledger GROUP BY user_id) l ON l.user_id = u.user_id
  `).all() as { uid: number; balance: number; ledger_sum: number }[];
  for (const r of rows) {
    expect(r.balance, `user ${r.uid} balance≠SUM(ledger)`).toBe(r.ledger_sum);
  }
  return rows.length;
}

describe('账本不变量：混合事务序列后 balance==SUM(ledger)（唯一事实源）', () => {
  test('注册/套餐/散充/兑换/消耗/透支/管理员/退款核销 全序列——每阶段全局对账恒等，重放不双记', () => {
    const db = makeDb();
    const A = addUser(db, 'a@t.com');
    const B = addUser(db, 'b@t.com');
    const C = addUser(db, 'c@t.com');

    // ── 阶段1：注册赠送（reg-<uid> 幂等）+ 重放 ──
    gongdaoGrant(A, 300, GONGDAO_LEDGER_TYPE.register, `reg-${A}`, null, db);
    gongdaoGrant(B, 300, GONGDAO_LEDGER_TYPE.register, `reg-${B}`, null, db);
    expect(gongdaoGrant(A, 300, GONGDAO_LEDGER_TYPE.register, `reg-${A}`, null, db)).toBe(false);
    expect(getGongdao(A, db)).toBe(300);
    assertGlobalInvariant(db);

    // ── 阶段2：A 买中配套餐（+9000 会员额度 + 30 天会员期），回调重放不双记 ──
    insertOrder(db, 'ORD-A-MEM', A, MEMBERSHIP_SKU_NAME.standard, 5900);
    payCallback(db, 'ORD-A-MEM');
    payCallback(db, 'ORD-A-MEM'); // 重放：status 守卫 + ledger 唯一索引双保险
    expect(getGongdao(A, db)).toBe(300 + MEMBERSHIP.standard.gongdao);
    expect(getMembership(db, A).active).toBe(true);
    assertGlobalInvariant(db);

    // ── 阶段3：B 散充 ¥30，直接二次 fulfillOrder 也幂等 ──
    insertOrder(db, 'ORD-B-REC', B, '散充·30元', 3000);
    payCallback(db, 'ORD-B-REC');
    fulfillOrder(db, { user_id: B, order_no: 'ORD-B-REC', amount_fen: 3000, sku_id: skuId(db, '散充·30元') });
    expect(getGongdao(B, db)).toBe(300 + rechargeGongdao(30));
    assertGlobalInvariant(db);

    // ── 阶段4：C 兑换码入账 + 重放 ──
    db.prepare('INSERT INTO redemption_codes (code, gongdao_value) VALUES (?,?)').run('LAW-INV1', 500);
    expect(redeemCode(db, C, 'LAW-INV1').ok).toBe(true);
    expect(redeemCode(db, C, 'LAW-INV1').ok).toBe(false);
    expect(getGongdao(C, db)).toBe(500);
    assertGlobalInvariant(db);

    // ── 阶段5：消耗结算 + 重放不双扣 ──
    gongdaoSettle(A, 23, 'intake-A1', 'intake', db);
    gongdaoSettle(A, 23, 'intake-A1', 'intake', db);
    expect(getGongdao(A, db)).toBe(300 + MEMBERSHIP.standard.gongdao - 23);
    assertGlobalInvariant(db);

    // ── 阶段6：最后一单透支入负（宁可少扣不可多扣；负余额随后被 gate 拦）──
    gongdaoSettle(C, 5000, 'draft-C1', 'draft', db);
    expect(getGongdao(C, db)).toBe(500 - 5000);
    expect(gongdaoGate(C, db)).toBe(false);
    assertGlobalInvariant(db);

    // ── 阶段7：管理员调整（不去重；负向不可致负）──
    expect(adminAdjustGongdao(A, 100, '客诉补偿', db).ok).toBe(true);
    expect(adminAdjustGongdao(A, -50, '误发扣回', db).ok).toBe(true);
    expect(adminAdjustGongdao(C, -1, '给负余额再扣', db).ok).toBe(false); // 被拒，不写行
    expect(getGongdao(A, db)).toBe(300 + MEMBERSHIP.standard.gongdao - 23 + 100 - 50);
    assertGlobalInvariant(db);

    // ── 阶段8：定额预扣 + 失败退款（refund-<chargeRef> 幂等）──
    gongdaoSettle(B, 2000, 'attest-B1', 'attest', db);
    expect(gongdaoRefund(B, 2000, 'attest-B1', 'attest', db)).toBe(true);
    expect(gongdaoRefund(B, 2000, 'attest-B1', 'attest', db)).toBe(false);
    expect(getGongdao(B, db)).toBe(300 + rechargeGongdao(30));
    assertGlobalInvariant(db);

    // ── 阶段9：退款核销（删会员期 + 负记「失败核销」精确回收）+ 重放不双核销 ──
    const memOrder = { user_id: A, order_no: 'ORD-A-MEM', amount_fen: 5900, sku_id: skuId(db, MEMBERSHIP_SKU_NAME.standard) };
    const beforeRefund = getGongdao(A, db);
    reverseOrder(db, memOrder);
    reverseOrder(db, memOrder);
    expect(getGongdao(A, db)).toBe(beforeRefund - MEMBERSHIP.standard.gongdao);
    expect(getMembership(db, A).active).toBe(false);
    expect(assertGlobalInvariant(db)).toBe(3); // 三个用户全部核验到（样本非空）
  });
});

describe('账本不变量：消费结算 = 实际 usage 汇总 ceil（无双扣、失败只扣已消耗）', () => {
  test('一次任务多段 token 用量累计 → 结算额 == ceil(精确成本)；二次结算不双扣', () => {
    const db = makeDb();
    const uid = addUser(db, 'j@t.com');
    gongdaoGrant(uid, 10000, GONGDAO_LEDGER_TYPE.membership, 'seed', null, db);

    const ref = 'intake-J1';
    const segments = [
      { promptTokens: 1200, completionTokens: 0 },                        // 问句理解
      { embedTokens: 900 },                                               // 知识检索向量
      { promptTokens: 8800, completionTokens: 3000,                       // 主 LLM
        cacheReadTokens: 5000, cacheWriteTokens: 2000 },                  // （首轮写缓存 + 续轮命中）
    ];
    const usage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, embedTokens: 0 };
    for (const s of segments) {
      usage.promptTokens += s.promptTokens ?? 0;
      usage.completionTokens += s.completionTokens ?? 0;
      usage.cacheReadTokens += s.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += s.cacheWriteTokens ?? 0;
      usage.embedTokens += s.embedTokens ?? 0;
      recordTokenUsage(uid, 'intake', 'DeepSeek-V4-Flash-0731', s, ref, null, db);
    }

    const cost = costOfUsage(usage, DEFAULT_RATES);
    expect(cost).toBe(Math.ceil(exactGongdaoOfUsage(usage, DEFAULT_RATES)));

    const before = getGongdao(uid, db);
    gongdaoSettle(uid, cost, ref, 'intake', db);
    gongdaoSettle(uid, cost, ref, 'intake', db); // 重放同 ref → 不双扣
    expect(getGongdao(uid, db)).toBe(before - cost);

    const consume = db.prepare(
      'SELECT COUNT(*) c, COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE ref_id=? AND type=?',
    ).get(ref, GONGDAO_LEDGER_TYPE.consume) as { c: number; s: number };
    expect(consume).toEqual({ c: 1, s: -cost });

    // token_usage 分段明细之和 == 一次性汇总的 cost_li（分段记账不丢精度对不上）
    const li = db.prepare('SELECT COALESCE(SUM(cost_li),0) s FROM token_usage WHERE ref_id=?').get(ref) as { s: number };
    expect(Math.abs(li.s - Math.round(exactGongdaoOfUsage(usage, DEFAULT_RATES) * 1000))).toBeLessThanOrEqual(segments.length);
    assertGlobalInvariant(db);
  });

  test('失败结算只扣实际已消耗（无预扣退费）：cost=0 只落幂等标记、余额不动', () => {
    const db = makeDb();
    const uid = addUser(db, 'f@t.com');
    gongdaoGrant(uid, 300, GONGDAO_LEDGER_TYPE.register, `reg-${uid}`, null, db);
    gongdaoSettle(uid, 0, 'intake-F1', 'intake', db);
    expect(getGongdao(uid, db)).toBe(300);
    const row = db.prepare('SELECT delta FROM gongdao_ledger WHERE ref_id=? AND type=?')
      .get('intake-F1', GONGDAO_LEDGER_TYPE.consume) as { delta: number };
    expect(row.delta).toBe(0);
    assertGlobalInvariant(db);
  });
});

describe('账本不变量：随机混打序列（含幂等重放）后仍恒等', () => {
  /** 确定性 PRNG（mulberry32）——随机但可复现，失败可原样重跑。 */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('600 步 grant/settle/refund/adjust/fulfill/redeem 混打，每步全局对账恒等', () => {
    const db = makeDb();
    const users = [addUser(db, 'r1@t.com'), addUser(db, 'r2@t.com'), addUser(db, 'r3@t.com')];
    const rand = rng(20260819);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const features = ['intake', 'companion', 'draft', 'ocr', 'asr', 'knowledge'] as const;
    const skuNames = [
      MEMBERSHIP_SKU_NAME.entry, MEMBERSHIP_SKU_NAME.standard, MEMBERSHIP_SKU_NAME.pro,
      '散充·10元', '散充·30元', '散充·50元',
    ] as const;

    /** 已履约订单（供后续随机 reverse）。 */
    const paidOrders: { user_id: number; order_no: string; amount_fen: number; sku_id: number }[] = [];
    /** 已结算的定额扣费（供后续随机 refund）。 */
    const charges: { uid: number; amount: number; ref: string; feature: string }[] = [];
    let seq = 0;

    for (let step = 0; step < 600; step++) {
      const uid = pick(users);
      const replay = rand() < 0.3; // 三成概率把上一动作原样重放一次
      const op = Math.floor(rand() * 6);
      seq++;

      if (op === 0) {
        const ref = `grant-${seq}`;
        gongdaoGrant(uid, 100 + Math.floor(rand() * 900), GONGDAO_LEDGER_TYPE.recharge, ref, null, db);
        if (replay) gongdaoGrant(uid, 100 + Math.floor(rand() * 900), GONGDAO_LEDGER_TYPE.recharge, ref, null, db);
      } else if (op === 1) {
        const ref = `settle-${seq}`;
        const feature = pick(features);
        const amount = Math.floor(rand() * 800);
        gongdaoSettle(uid, amount, ref, feature, db);
        if (replay) gongdaoSettle(uid, amount, ref, feature, db);
        if (amount > 0) charges.push({ uid, amount, ref, feature });
      } else if (op === 2) {
        const c = charges.length ? charges[Math.floor(rand() * charges.length)] : null;
        if (c) {
          gongdaoRefund(c.uid, c.amount, c.ref, c.feature, db);
          if (replay) gongdaoRefund(c.uid, c.amount, c.ref, c.feature, db);
        }
      } else if (op === 3) {
        const delta = Math.floor(rand() * 2000) - 1000;
        const before = getGongdao(uid, db);
        const res = adminAdjustGongdao(uid, delta, `随机调整-${seq}`, db);
        // 调整不可致负：被拒时余额纹丝不动
        if (!res.ok) expect(getGongdao(uid, db)).toBe(before);
        else expect(res.balance).toBeGreaterThanOrEqual(0);
      } else if (op === 4) {
        const skuName = pick(skuNames);
        const orderNo = `ORD-${seq}`;
        const amountFen = 1000 + Math.floor(rand() * 20000);
        insertOrder(db, orderNo, uid, skuName, amountFen);
        payCallback(db, orderNo);
        if (replay) payCallback(db, orderNo);
        const order = { user_id: uid, order_no: orderNo, amount_fen: amountFen, sku_id: skuId(db, skuName) };
        paidOrders.push(order);
        // 一成概率立刻退款核销（含重放）
        if (rand() < 0.1) {
          reverseOrder(db, order);
          if (replay) reverseOrder(db, order);
        }
      } else {
        const code = `LAW-R${seq}`;
        db.prepare('INSERT INTO redemption_codes (code, gongdao_value) VALUES (?,?)').run(code, 100 + Math.floor(rand() * 400));
        redeemCode(db, uid, code);
        if (replay) expect(redeemCode(db, uid, code).ok).toBe(false); // 二次必 used
      }

      expect(assertGlobalInvariant(db), `第 ${step} 步后对账样本为空`).toBeGreaterThan(0);
    }

    // 收尾：把还没退的订单全部核销一遍（再次含重放），对账仍恒等
    for (const o of paidOrders) {
      reverseOrder(db, o);
      reverseOrder(db, o);
    }
    expect(assertGlobalInvariant(db)).toBe(users.length);

    // 样本非空校验：确实产生了各类流水
    const types = db.prepare('SELECT DISTINCT type FROM gongdao_ledger').all() as { type: string }[];
    expect(types.length).toBeGreaterThanOrEqual(6);
  });
});
