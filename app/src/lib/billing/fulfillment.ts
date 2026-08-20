// app/src/lib/billing/fulfillment.ts
// SKU 语义 + 订单履约（钱的地基·消费端）。
// SKU 语义在此运行时判定：三档月卡（按套餐直给公道值 + 记会员期）、散充（金额×100 公道值）。
// 全部以 orderNo 幂等（gongdaoGrant 唯一索引 + memberships uq_memberships_order + writeoff 唯一索引）。
// 支付成功走 fulfillOrder；退款核销走 reverseOrder；均设计为在调用方事务内原子执行。
import type Database from 'better-sqlite3';
import {
  GONGDAO_LEDGER_TYPE,
  MEMBERSHIP,
  rechargeGongdao,
  type MembershipPlan,
} from './pricing';
import { gongdaoGrant } from './index';

/** 三档月卡 SKU 的规范名（SKU 语义靠此判定；由 ensureBillingSkus 种入，勿改名）。 */
export const MEMBERSHIP_SKU_NAME = {
  entry: '套餐·入门',
  standard: '套餐·中配',
  pro: '套餐·高配',
} as const;

/** 自定义金额散充的挂靠 SKU 名（任意面额统一挂靠此行；履约按订单 amount_fen 计）。 */
export const CUSTOM_RECHARGE_SKU_NAME = '散充·自定义';

/** 固定散充面额（元）——与前端展示、orders 路由校验同源；履约仍按实付金额×100 计。 */
export const RECHARGE_SKU_YUAN = [10, 30, 50] as const;

export type SkuKind =
  | { kind: 'membership'; plan: MembershipPlan }
  | { kind: 'recharge' };

/** 可履约订单最小形态（支付回调 / 退款共用）。 */
export interface FulfillableOrder {
  user_id: number;
  order_no: string;
  amount_fen: number;
  sku_id: number;
}

/**
 * 判定 SKU 语义：按规范名命中三档月卡，否则一律按「散充」处理（金额×100 公道值）。
 * 名匹配是唯一判据（同价的套餐与散充面额无法用价区分）。
 * SKU 不存在（历史/已删）时退化为散充，按实付金额计。
 */
export function resolveSkuKind(db: Database.Database, skuId: number): SkuKind {
  const sku = db.prepare('SELECT name FROM skus WHERE id=?').get(skuId) as { name: string } | undefined;
  const name = sku?.name ?? '';
  if (name === MEMBERSHIP_SKU_NAME.entry) return { kind: 'membership', plan: 'entry' };
  if (name === MEMBERSHIP_SKU_NAME.standard) return { kind: 'membership', plan: 'standard' };
  if (name === MEMBERSHIP_SKU_NAME.pro) return { kind: 'membership', plan: 'pro' };
  return { kind: 'recharge' };
}

/**
 * 授予会员期。续期叠加：新到期 = max(当前有效到期, now) + 套餐天数。
 * 幂等：同 orderNo 只赋一次（uq_memberships_order）。
 * @returns true=本次真实写入会员期；false=命中幂等（该订单已赋期）。
 */
export function grantMembership(
  db: Database.Database,
  userId: number,
  plan: MembershipPlan,
  orderNo: string,
): boolean {
  const days = MEMBERSHIP[plan].days;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO memberships (user_id, plan, order_no, started_at, expires_at)
       VALUES (
         ?, ?, ?, datetime('now'),
         datetime(
           COALESCE(
             (SELECT MAX(expires_at) FROM memberships WHERE user_id=? AND expires_at > datetime('now')),
             datetime('now')
           ),
           ?
         )
       )`,
    )
    .run(userId, plan, orderNo, userId, `+${days} days`);
  return res.changes > 0;
}

/**
 * 支付成功履约（应在调用方「订单 pending→credited」事务内调用，保证原子）。
 * 套餐：入套餐公道值（会员额度）+ 记会员期；散充：按实付金额×RECHARGE_GONGDAO_PER_YUAN 入公道值（充值）。
 * 全部以 orderNo 幂等，重复调用绝不双记/双扣。
 */
export function fulfillOrder(db: Database.Database, order: FulfillableOrder): void {
  const kind = resolveSkuKind(db, order.sku_id);
  if (kind.kind === 'membership') {
    const { plan } = kind;
    gongdaoGrant(
      order.user_id,
      MEMBERSHIP[plan].gongdao,
      GONGDAO_LEDGER_TYPE.membership,
      order.order_no,
      { plan, orderNo: order.order_no },
      db,
    );
    grantMembership(db, order.user_id, plan, order.order_no);
  } else {
    gongdaoGrant(
      order.user_id,
      rechargeGongdao(order.amount_fen / 100),
      GONGDAO_LEDGER_TYPE.recharge,
      order.order_no,
      { amountFen: order.amount_fen },
      db,
    );
  }
}

/**
 * 退款核销（应在退款事务内调用）：回收该订单所授（会员期删除 + 公道值负记「失败核销」）。
 * 核销额取账本实际入账（会员额度/充值，ref_id=orderNo）——ledger 是唯一事实源，不重算 SKU，
 * 故 SKU 改名/删除、乃至兜底以散充语义入账的订单亦能精确回收。
 * 幂等：writeoff-<orderNo> 唯一索引兜底，重复退款不重复核销。
 * 允许公道值入负（用户已消费即透支，负余额被 gate 拦）。
 */
export function reverseOrder(db: Database.Database, order: FulfillableOrder): void {
  // 会员回收：删除本订单赋予的会员期（续期叠加时仅回收本订单行；散充订单无行，无副作用）
  db.prepare('DELETE FROM memberships WHERE order_no=?').run(order.order_no);

  // 核销额 = 本订单实际入账公道值（正向 会员额度/充值 之和）
  const granted = db.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS s FROM gongdao_ledger WHERE ref_id=? AND type IN (?, ?)',
  ).get(order.order_no, GONGDAO_LEDGER_TYPE.membership, GONGDAO_LEDGER_TYPE.recharge) as { s: number };
  const gongdao = granted.s;
  if (gongdao <= 0) return; // 无正向入账可核销

  // 公道值核销：负记（幂等 by (失败核销, writeoff-<orderNo>)）+ 余额扣减
  const refId = `writeoff-${order.order_no}`;
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id, meta_json) VALUES (?,?,?,?,?)',
    )
    .run(order.user_id, -gongdao, GONGDAO_LEDGER_TYPE.writeoff, refId, JSON.stringify({ orderNo: order.order_no }));
  if (res.changes > 0) {
    db.prepare(
      'INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance - ?',
    ).run(order.user_id, -gongdao, gongdao);
  }
}

/** 当前有效会员状态（供 /api/me 等前端接口取用）。 */
export interface MembershipStatus {
  active: boolean;
  plan: MembershipPlan | null;
  expiresAt: string | null;
}

export function getMembership(db: Database.Database, userId: number): MembershipStatus {
  const row = db
    .prepare(
      "SELECT plan, expires_at FROM memberships WHERE user_id=? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1",
    )
    .get(userId) as { plan: MembershipPlan; expires_at: string } | undefined;
  if (!row) return { active: false, plan: null, expiresAt: null };
  return { active: true, plan: row.plan, expiresAt: row.expires_at };
}

/**
 * 幂等种入计费 SKU（三档月卡 + 固定散充面额 + 自定义散充挂靠行）。
 * migrate.ts 不含 SKU 种子，改价改额只此一处；按 name upsert，重复调用安全。
 * 中配/高配待开发（D3 修订 2026-08-20），entry 为唯一可售档：两档仍保留行与定价草案
 * （历史订单要按 sku_id 溯源，改回可售也只是把 enabled 翻回 1），但 enabled=0 关掉购买入口。
 */
export function ensureBillingSkus(db: Database.Database): void {
  const upsert = (name: string, priceFen: number, gongdao: number, enabled: 0 | 1) => {
    const row = db.prepare('SELECT id FROM skus WHERE name=?').get(name) as { id: number } | undefined;
    if (row) db.prepare('UPDATE skus SET gongdao=?, price_fen=?, enabled=? WHERE id=?').run(gongdao, priceFen, enabled, row.id);
    else db.prepare('INSERT INTO skus (name, gongdao, price_fen, enabled) VALUES (?,?,?,?)').run(name, gongdao, priceFen, enabled);
  };
  db.transaction(() => {
    for (const plan of ['entry', 'standard', 'pro'] as const) {
      // 入门档 19.9 元 → 1990 分：priceYuan 可含小数，一律 round 到分
      upsert(
        MEMBERSHIP_SKU_NAME[plan],
        Math.round(MEMBERSHIP[plan].priceYuan * 100),
        MEMBERSHIP[plan].gongdao,
        plan === 'entry' ? 1 : 0,
      );
    }
    for (const yuan of RECHARGE_SKU_YUAN) upsert(`散充·${yuan}元`, yuan * 100, rechargeGongdao(yuan), 1);
    // 自定义金额散充的挂靠 SKU（orders.sku_id 外键需要一行；实付与公道值按订单动态记）。
    // enabled=0：不进 GET SKU 列表（¥0 占位行对外无意义），orders 路由按名内部引用。
    upsert(CUSTOM_RECHARGE_SKU_NAME, 0, 0, 0);
  })();
}

/**
 * 下单守门：SKU 不可售（不存在或 enabled=0）即抛。
 * M3 支付移植建 orders 路由时，下单前必须先走本函数——**这是 disabled 拒单的唯一守门**，
 * 别处没有第二道，漏调即等于把待开发档与内部挂靠行重新摆上货架。
 *
 * 语义分界（钱的事故高发区，两侧混判必错）：
 *   - 下单侧（本函数）看 enabled —— 现在还能不能卖。
 *   - 履约侧（fulfillOrder）**有意不看 enabled** —— 履约发生在支付回调，钱已经收了；
 *     用户下单后 SKU 才被下架（或本就是内部挂靠的散充行），该笔历史订单仍必须照常入账，
 *     否则就是收了钱不发货。拒单只归下单侧。
 */
export function assertSkuSellable(db: Database.Database, skuId: number): void {
  const sku = db.prepare('SELECT name, enabled FROM skus WHERE id=?').get(skuId) as
    { name: string; enabled: number } | undefined;
  if (!sku) throw new Error(`SKU 不存在：${skuId}`);
  if (sku.enabled !== 1) throw new Error(`SKU 已下架不可售：${skuId}（${sku.name}）`);
}
