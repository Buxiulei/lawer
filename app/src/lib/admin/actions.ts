// app/src/lib/admin/actions.ts
// 后台的两个变更动作：调会员档、发公道值。两者都在一个事务里连同 admin_audit 一起落。
//
// ── 铁律：发钱只经 lib/billing 的唯一入口 ──
// 本文件**不含**任何 `INSERT INTO gongdao_ledger` / `UPDATE gongdao`，一律调 gongdaoGrant。
// 绕过它就绕过了 (type, ref_id) 幂等索引与「流水与余额同事务增减」这两条，
// 于是「余额 ≡ Σledger」那条全局不变量会在**某一个后台操作之后**开始说谎，
// 而说谎的方式是页面上出现一个看起来完全正常的错数。
// 结构守卫 __tests__/no-direct-ledger-write.test.ts 机检这条。
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { getGongdao, gongdaoGrant } from '@/lib/billing/index';
import { getMembership, grantMembership } from '@/lib/billing/fulfillment';
import { GONGDAO_LEDGER_TYPE, type MembershipPlan } from '@/lib/billing/pricing';
import { ADMIN_ACTION, writeAudit } from './audit';

/** 后台可选的会员时长（天）。档位与时长解耦，见 grantMembership 的 overrideDays。 */
export const ADMIN_MEMBERSHIP_DAYS = [31, 92, 365] as const;
export type AdminMembershipDays = (typeof ADMIN_MEMBERSHIP_DAYS)[number];

/** 档位高低，只用于判「是不是降档」。 */
const PLAN_RANK: Record<MembershipPlan, number> = { entry: 1, standard: 2, pro: 3 };

/**
 * 公道值入账的 scene 标记（写进 ledger 的 meta_json）。
 *
 * 【为什么 scene 进 meta，而不是新开一个 GONGDAO_LEDGER_TYPE】
 * type 是账本的**分类学**，八个值撑着对账脚本、reverseOrder 的回收口径与 estimate 的部分索引；
 * 为一个来源新增一个 type，等于让所有「按 type 求和」的既有查询各自漏掉一类钱，
 * 而它们不会报错，只会少算。后台发的钱语义上就是「管理员调整」的正向那一半，
 * 归到既有的 '管理员调整' 里，来源细节进 meta_json——查得到，且不动分类学。
 */
export const ADMIN_GRANT_SCENE = 'admin_grant';

/** 操作痕：会员行的 order_no 与账本的 ref_id 都以它开头，一眼看出「这是后台某人手动做的」。 */
export function adminOpStamp(operatorUid: number, now: Date = new Date()): string {
  return `admin-${operatorUid}-${now.getTime()}`;
}

/** 发公道值的幂等键：操作痕 + 随机尾巴（同一次确认重试复用同一个，故必须由调用方持有）。 */
export function newAdminGrantRef(operatorUid: number, now: Date = new Date()): string {
  return `${adminOpStamp(operatorUid, now)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** ref 形状守卫：必须是本操作者的操作痕，防一个管理员把动作记到另一个人头上。 */
export function isAdminGrantRef(ref: string, operatorUid: number): boolean {
  return new RegExp(`^admin-${operatorUid}-\\d{10,}-[0-9a-f]{8}$`).test(ref);
}

// ───────────────────────────── 调会员档 ─────────────────────────────

export type AdminMembershipResult =
  | {
      ok: true;
      orderNo: string;
      plan: MembershipPlan;
      days: number;
      /** 降档：当前有效行已被提前到期，新行从此刻起算 */
      downgraded: boolean;
      expiresAt: string | null;
      prevPlan: MembershipPlan | null;
      prevExpiresAt: string | null;
    }
  | { ok: false; reason: 'bad_days' | 'duplicate_order' };

/**
 * 后台调会员档，**立即生效**。
 *
 * 【升档/续期 vs 降档，为什么要分两条路】
 * grantMembership 的默认语义是续期叠加（新到期 = max(当前有效到期, now) + 天数），
 * 而 getMembership 取的是「有效行里 expires_at 最大的那条」。
 *   · 升档、同档续期：新行的到期天然更晚，它立刻就是当前档 —— 叠加正确，无需干预。
 *   · 降档：把 entry 叠在还剩 300 天的 pro 后面，用户在这 300 天里仍然是 pro，
 *     「立即生效」四个字就成了谎。所以降档先把当前有效行 expires_at 提前到此刻，
 *     新行再从此刻起算 —— 这正是工单写的「当前行提前到期 + 新行」。
 * 提前到期用 UPDATE 而不是 DELETE：那一行是历史事实（他确实买过、确实用过一段），
 * 删掉就再也解释不了他这半年为什么走的是 Claude 路由。
 *
 * 幂等：orderNo 撞已存在的行即整笔拒绝（不提前到期、不写审计），由调用方重试换新 stamp。
 * 事务内原子：提前到期 + 新行 + 审计三样一起成、一起不成。
 */
export function adminSetMembership(
  db: Database.Database,
  input: {
    operatorUid: number;
    targetUid: number;
    plan: MembershipPlan;
    days: number;
    orderNo: string;
    note?: string;
  },
): AdminMembershipResult {
  const days = Math.trunc(input.days);
  if (!(ADMIN_MEMBERSHIP_DAYS as readonly number[]).includes(days)) {
    return { ok: false, reason: 'bad_days' };
  }

  return db.transaction((): AdminMembershipResult => {
    const dup = db.prepare('SELECT 1 AS x FROM memberships WHERE order_no=?').get(input.orderNo);
    if (dup) return { ok: false, reason: 'duplicate_order' };

    const before = getMembership(db, input.targetUid);
    const downgraded =
      before.active && before.plan !== null && PLAN_RANK[before.plan] > PLAN_RANK[input.plan];

    if (downgraded) {
      db.prepare(
        "UPDATE memberships SET expires_at = datetime('now') WHERE user_id=? AND expires_at > datetime('now')",
      ).run(input.targetUid);
    }

    grantMembership(db, input.targetUid, input.plan, input.orderNo, days);
    const after = getMembership(db, input.targetUid);

    writeAudit(db, {
      operatorUid: input.operatorUid,
      action: ADMIN_ACTION.grantMembership,
      targetUid: input.targetUid,
      detail: {
        plan: input.plan,
        days,
        order_no: input.orderNo,
        downgraded,
        prev_plan: before.plan,
        prev_expires_at: before.expiresAt,
        expires_at: after.expiresAt,
        note: input.note ?? '',
      },
    });

    return {
      ok: true,
      orderNo: input.orderNo,
      plan: input.plan,
      days,
      downgraded,
      expiresAt: after.expiresAt,
      prevPlan: before.plan,
      prevExpiresAt: before.expiresAt,
    };
  })();
}

// ───────────────────────────── 发公道值 ─────────────────────────────

export type AdminGongdaoResult =
  | {
      ok: true;
      refId: string;
      delta: number;
      balance: number;
      /** false = 撞幂等（这个 refId 已经发过），余额未变 */
      applied: boolean;
    }
  | { ok: false; reason: 'bad_amount' };

/**
 * 后台发公道值。走 gongdaoGrant（唯一入口），(type, refId) 唯一索引保证同 refId 只入账一次。
 *
 * 【撞幂等也要落审计】applied=false 照样写 admin_audit 行——「试过但没生效」与「没试过」
 * 必须在审计里分得开，否则重复点击与重放攻击长得一模一样（见 migrate.ts 表注释）。
 * 事务内原子：入账与审计一起成、一起不成。
 */
export function adminGrantGongdao(
  db: Database.Database,
  input: {
    operatorUid: number;
    targetUid: number;
    delta: number;
    note: string;
    refId: string;
  },
): AdminGongdaoResult {
  const delta = Math.trunc(input.delta);
  if (!Number.isFinite(delta) || delta <= 0) return { ok: false, reason: 'bad_amount' };

  return db.transaction((): AdminGongdaoResult => {
    const applied = gongdaoGrant(
      input.targetUid,
      delta,
      GONGDAO_LEDGER_TYPE.admin,
      input.refId,
      {
        scene: ADMIN_GRANT_SCENE,
        operator_uid: input.operatorUid,
        note: input.note,
      },
      db,
    );
    const balance = getGongdao(input.targetUid, db);

    writeAudit(db, {
      operatorUid: input.operatorUid,
      action: ADMIN_ACTION.grantGongdao,
      targetUid: input.targetUid,
      detail: {
        delta,
        note: input.note,
        ref_id: input.refId,
        scene: ADMIN_GRANT_SCENE,
        applied,
        balance_after: balance,
      },
    });

    return { ok: true, refId: input.refId, delta, balance, applied };
  })();
}
