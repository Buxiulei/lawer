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
import { ENTITLEMENT_KIND, grantEntitlement, revokeUnconsumedBySource } from './entitlements';

/** 三档月卡 SKU 的规范名（SKU 语义靠此判定；由 ensureBillingSkus 种入，勿改名）。 */
export const MEMBERSHIP_SKU_NAME = {
  entry: '套餐·入门',
  standard: '套餐·中配',
  pro: '套餐·高配',
} as const;

/** 自定义金额散充的挂靠 SKU 名（任意面额统一挂靠此行；履约按订单 amount_fen 计）。 */
export const CUSTOM_RECHARGE_SKU_NAME = '散充·自定义';

/**
 * 中/高档会员解封开关的环境变量名（暗启 · spec v3 §7.1/A2）。
 * 默认关（未配置 = false）：standard/pro 的购买入口关闭（SKU enabled=0），entry 始终可售。
 * 【为什么是 env 而不是代码常量】解封是一次运维放行动作，不该要求改代码重新发版——
 * 与凭据同类：代码里只有变量名，值只进 env 文件。
 * 【开启前置】用户可见开放前置 = claude 路由评测批绿（评测绿即自动放行，不再等 manager 人工拍板）。
 * 本文件只实现「读 flag 决定可售与否」，谁在评测绿后翻这个 env 是运维/CI 的事，不在代码里。
 */
export const MEMBERSHIP_TIERS_UNLOCKED_ENV = 'LAWER_MEMBERSHIP_TIERS_UNLOCKED';

/**
 * 中/高档会员是否已解封。未配置或非真值一律 false（暗启默认关）。
 * 真值判据取显式白名单（1/true/yes/on），避免把 '0'/'false' 这类"配了但想关"的值当成开——
 * 半配置比没配置更容易误判，此处宁可严：只有明确写开才算开。
 */
export function membershipTiersUnlocked(): boolean {
  const v = process.env[MEMBERSHIP_TIERS_UNLOCKED_ENV]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

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
 * @param overrideDays 覆盖套餐自带天数。**只给后台手工开通用**（lib/admin，档位与时长解耦：
 *   同一个 pro 档可以开 31/92/365 天）。支付履约侧一律不传——套餐卖的是「哪一档 × 多少天」
 *   这一整个组合，让回调能自己挑天数就等于让订单金额与所得权益脱钩。
 * @returns true=本次真实写入会员期；false=命中幂等（该订单已赋期）。
 */
export function grantMembership(
  db: Database.Database,
  userId: number,
  plan: MembershipPlan,
  orderNo: string,
  overrideDays?: number,
): boolean {
  const days = overrideDays ?? MEMBERSHIP[plan].days;
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
 * 套餐：入套餐公道值（会员额度）+ 记会员期 + 发一张核心四项券；散充：按实付金额×RECHARGE_GONGDAO_PER_YUAN 入公道值（充值）。
 * 全部以 orderNo 幂等，重复调用绝不双记/双扣/双发。
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
    // 买会员立刻送一张核心四项券（dossier_core，覆盖 venue+entity+graph+docs_list 一次）。
    // source_ref 取订单号：(kind, source_ref) 部分唯一索引就是发券的幂等键，支付回调重放
    // 落到同一个 order_no 上，INSERT OR IGNORE 直接 changes=0，不会多送一张。
    // 与上面的公道值、会员期同在调用方履约事务内：三样一起成、一起不成。
    grantEntitlement(db, order.user_id, ENTITLEMENT_KIND.dossierCore, order.order_no);
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
 * 退款核销（应在退款事务内调用）：回收该订单所授（会员期删除 + 赠券作废 + 公道值负记「失败核销」）。
 * 核销额取账本实际入账（会员额度/充值，ref_id=orderNo）——ledger 是唯一事实源，不重算 SKU，
 * 故 SKU 改名/删除、乃至兜底以散充语义入账的订单亦能精确回收。
 * 幂等：writeoff-<orderNo> 唯一索引兜底，重复退款不重复核销。
 * 允许公道值入负（用户已消费即透支，负余额被 gate 拦）。
 */
export function reverseOrder(db: Database.Database, order: FulfillableOrder): void {
  // 会员回收：删除本订单赋予的会员期（续期叠加时仅回收本订单行；散充订单无行，无副作用）
  db.prepare('DELETE FROM memberships WHERE order_no=?').run(order.order_no);

  // 赠券回收：只作废本单发出、**尚未核销**的券。已核销的不追回——档案已经交付了，
  // 把那张券收回来只会让「这条档案为什么没扣钱」再也答不上来（见 revokeUnconsumedBySource）。
  // 放在下面那条「无正向入账即 return」之前：未履约就退的单本来也没券，多跑一次影响 0 行。
  revokeUnconsumedBySource(db, ENTITLEMENT_KIND.dossierCore, order.order_no);

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
 *
 * 中/高档解封（spec v3 §7.1/A2）：standard/pro 的 enabled 由 flag
 * `LAWER_MEMBERSHIP_TIERS_UNLOCKED`（默认关）决定——关时 enabled=0 关掉购买入口、开时翻 1。
 * entry 始终可售。两档的行与定价草案无论开关都保留（历史订单按 sku_id 溯源，解封只是把 enabled 翻 1）。
 * enabled 是随 flag 每次开库都重算的（种子挂在启动路径上），故翻 env + 重启即生效、无需数据迁移。
 */
export function ensureBillingSkus(db: Database.Database): void {
  const upsert = (name: string, priceFen: number, gongdao: number, enabled: 0 | 1) => {
    const row = db.prepare('SELECT id FROM skus WHERE name=?').get(name) as { id: number } | undefined;
    if (row) db.prepare('UPDATE skus SET gongdao=?, price_fen=?, enabled=? WHERE id=?').run(gongdao, priceFen, enabled, row.id);
    else db.prepare('INSERT INTO skus (name, gongdao, price_fen, enabled) VALUES (?,?,?,?)').run(name, gongdao, priceFen, enabled);
  };
  const tiersUnlocked = membershipTiersUnlocked();
  db.transaction(() => {
    for (const plan of ['entry', 'standard', 'pro'] as const) {
      // 入门档 19.9 元 → 1990 分：priceYuan 可含小数，一律 round 到分
      upsert(
        MEMBERSHIP_SKU_NAME[plan],
        Math.round(MEMBERSHIP[plan].priceYuan * 100),
        MEMBERSHIP[plan].gongdao,
        plan === 'entry' || tiersUnlocked ? 1 : 0,
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
