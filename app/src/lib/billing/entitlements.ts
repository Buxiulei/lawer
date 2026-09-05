// app/src/lib/billing/entitlements.ts
// 权益券：会员赠送的一次性服务额度。当前唯一一种是 `dossier_core`——**买会员送核心四项一次**。
//
// ── 为什么是 dossier_core（只核心四项），不是"送一次整档" ──
// 拆包按篇计价后，"一次整档"的值域是 930~2720 公道值（探测篇数决定），
// 19.9 元月卡（给 3000 公道值）承担不起 2720 的敞口。核心四项是固定的 340，
// 深度模块（M5/M6）照常扣费。所以券只覆盖核心四项，值域锁死。
//
// ── 为什么另起一张表，而不是给 memberships 加一列 credit ──
// memberships 是**每个订单一行**、续期叠加（grantMembership 的 uq_memberships_order）。
// 在其上加 credit 列，「续期两次送几次」就成了隐式规则，且那一列没有自己的幂等键——
// 支付回调重放会不会多送一次，取决于谁先写的那条 UPDATE。本表 (kind, source_ref)
// 部分唯一索引就是幂等键（source_ref = order_no），重放只发一张。
//
// ── 核销不写账本 ──
// gongdao_ledger 只记钱；赠送的核心四项不是钱，写进去会让「账本求和 = 余额」这条不变量说谎。
// 于是「这单为什么没扣钱」的答案只存在于两处：本表的 consumed_at/consumed_ref，
// 与 company_dossiers.paid_by='membership_credit'/paid_ref。**两处都写，缺一不可**：
// 只写这边，从档案查不到为什么免费；只写那边，从券查不到用去了哪。
import type Database from 'better-sqlite3';

/** 权益券种类。值域在此锁死（库侧不加 CHECK，同 intake_stage 裁决）。 */
export const ENTITLEMENT_KIND = {
  /** 一次核心四项建档（仲裁地实操 + 主体体检 + 关联谱系 + 涉诉清单，值固定 340）。深度模块不覆盖。 */
  dossierCore: 'dossier_core',
  /**
   * 一次耗算力的内容提取或解读（OCR / 录音转写 / 视频提取 / 来文解读 / 证据简报任一）。
   * 消费侧是 lib/billing/service-quotes.ts 的 confirmService：确认时有券即核销、不扣公道值。
   *
   * ⚠ **今天没有任何发券路径**——会员送几张、送给哪一档，归会员权益那张工单。
   * 先落消费侧是因为计费流只有一处入口（confirmService），发券工单落地时不必再回来改它；
   * 在那之前 listUnconsumed 永远返回空数组，这条分支在生产上不会被走到。
   */
  serviceExtract: 'service_extract',
} as const;

export type EntitlementKind = (typeof ENTITLEMENT_KIND)[keyof typeof ENTITLEMENT_KIND];

export interface Entitlement {
  id: number;
  user_id: number;
  kind: string;
  source_ref: string | null;
  granted_at: string;
  consumed_at: string | null;
  consumed_ref: string | null;
  revoked_at: string | null;
}

/**
 * 发一张券。幂等：同 (kind, sourceRef) 只发一张（uq_entitlements_source 兜底）。
 * 应在调用方履约事务内调用（与 gongdaoGrant / grantMembership 同事务）。
 * @returns true=本次真发了一张；false=命中幂等（该来源已发过）。
 */
export function grantEntitlement(
  db: Database.Database,
  userId: number,
  kind: EntitlementKind,
  sourceRef: string,
): boolean {
  const res = db
    .prepare('INSERT OR IGNORE INTO entitlements (user_id, kind, source_ref) VALUES (?,?,?)')
    .run(userId, kind, sourceRef);
  return res.changes > 0;
}

/** 列出某人某类未核销、未作废的券（最早发的在前——先发先用，用户不必挑）。 */
export function listUnconsumed(
  db: Database.Database,
  userId: number,
  kind: EntitlementKind,
): Entitlement[] {
  return db
    .prepare(
      `SELECT id, user_id, kind, source_ref, granted_at, consumed_at, consumed_ref, revoked_at
         FROM entitlements
        WHERE user_id=? AND kind=? AND consumed_at IS NULL AND revoked_at IS NULL
        ORDER BY id ASC`,
    )
    .all(userId, kind) as Entitlement[];
}

/**
 * 核销一张券（先发先用）。
 *
 * 判据写在 UPDATE 的 WHERE 里、而不是先查再改：先 SELECT 再 UPDATE 之间隔着一个窗口，
 * 同一张券会被两个并发请求各领一次，于是两单都免费。`WHERE consumed_at IS NULL` 让
 * 抢输的那次 changes=0，函数返回 null，调用方照常走扣费——**多扣一次可以退，
 * 白送一次查不出来**。
 *
 * @param consumedRef 核销去向（如 `dossier-12`）。留痕用，不参与判定。
 * @returns 被核销的券 id；无可用券返回 null。
 */
export function consumeEntitlement(
  db: Database.Database,
  userId: number,
  kind: EntitlementKind,
  consumedRef: string,
): number | null {
  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM entitlements
          WHERE user_id=? AND kind=? AND consumed_at IS NULL AND revoked_at IS NULL
          ORDER BY id ASC LIMIT 1`,
      )
      .get(userId, kind) as { id: number } | undefined;
    if (!candidate) return null;
    const res = db
      .prepare(
        `UPDATE entitlements
            SET consumed_at = datetime('now'), consumed_ref = ?
          WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(consumedRef, candidate.id);
    return res.changes > 0 ? candidate.id : null;
  })();
}

/**
 * 归还一张**已核销**的券（消费后的履约失败时把额度还回去）。
 *
 * 与 revokeUnconsumedBySource 方向相反、场景也不同：那个作废**尚未核销**的券（整单退款，
 * 货没交付）；本函数把**已核销**的一张退回可用（券覆盖的那次服务失败了，货没交成）。
 *
 * 按 (id, consumed_ref) 定位：consumed_ref 是核销去向（confirmService 传的 orderRef），
 * 一次消费只核销一张、consumed_ref 唯一，据它退回不会误伤同一个人的别的券。
 * 幂等：退回后 consumed_at/consumed_ref 归 NULL，同 ref 再调时 `consumed_at IS NOT NULL`
 * 与 `consumed_ref=?` 都不再匹配（changes=0）——「重启回收后再失败」不会把额度退第二次。
 * @returns true=本次真退回一张；false=没有匹配的已核销券（已退过，或从没核销到这个去向）。
 */
export function restoreEntitlement(
  db: Database.Database,
  entitlementId: number,
  consumedRef: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE entitlements
          SET consumed_at = NULL, consumed_ref = NULL
        WHERE id = ? AND consumed_ref = ? AND consumed_at IS NOT NULL AND revoked_at IS NULL`,
    )
    .run(entitlementId, consumedRef);
  return res.changes > 0;
}

/**
 * 作废某来源发出的、**尚未核销**的券（订单退款时调用）。
 * 已核销的不追回——货已经交付了，把券收回来只会让「用过的券」凭空消失，
 * 那条已交付的档案就再也解释不了自己为什么没扣钱。
 * @returns 实际作废的张数。
 */
export function revokeUnconsumedBySource(
  db: Database.Database,
  kind: EntitlementKind,
  sourceRef: string,
): number {
  const res = db
    .prepare(
      `UPDATE entitlements
          SET revoked_at = datetime('now')
        WHERE kind=? AND source_ref=? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(kind, sourceRef);
  return res.changes;
}
