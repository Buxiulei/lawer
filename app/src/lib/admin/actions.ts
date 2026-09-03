// app/src/lib/admin/actions.ts
// 后台的四个变更动作：调会员档、发公道值、护照实名通过/驳回。
// 每一个都在一个事务里连同 admin_audit 一起落。
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
import {
  approvePassportRealname,
  rejectPassportRealname,
} from '@/lib/auth/passport-realname';
import { AUTH_STATUS } from '@/lib/auth/realname';
import { CERT_TYPE } from '@/lib/evidence/attest';
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
      /** false = 撞幂等（同 orderNo 已应用过）：本次未写新行、未提前到期、未再落审计，回的是首次结果 */
      applied: boolean;
    }
  | { ok: false; reason: 'bad_days' };

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
 * 幂等（跨请求）：orderNo 就是幂等键。由前端在「点确认」那一刻生成一次、在整个重试生命周期
 * 复用同一把（op_ref），所以一次网络重试落回同一个 orderNo，撞已存在的行即**幂等短路**：
 * 不提前到期、不写新行、不再落审计，回 applied=false + 当前会员态（首次结果），重试因此看到
 * 的是成功而非报错。若 orderNo 每次由服务端现生成毫秒戳，这条短路永远撞不上，重试就会把
 * 365 天叠成 730——这正是本函数存在的理由。
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
    if (dup) {
      // 幂等短路：同一把 orderNo 已经应用过。不提前到期、不写新行、不再落审计——
      // 把当前会员态当作「首次结果」回给调用方（applied=false），重试据此看到成功。
      const cur = getMembership(db, input.targetUid);
      return {
        ok: true,
        orderNo: input.orderNo,
        plan: input.plan,
        days,
        downgraded: false,
        expiresAt: cur.expiresAt,
        prevPlan: cur.plan,
        prevExpiresAt: cur.expiresAt,
        applied: false,
      };
    }

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
      applied: true,
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

// ─────────────────────── 护照实名审核（通过 / 驳回）───────────────────────

export type AdminRealnameResult =
  | { ok: true; userId: number; authStatus: string; certType?: string }
  /** 流水已落定 / 不是护照通道 / 原因为空等业务拒绝，reason 是可直接展示给管理员的原话 */
  | { ok: false; reason: string };

/**
 * 审核人的记名。**不是管理员填的字符串，是登录态里的 uid** ——
 * 让操作者自己写名字，等于让留痕可以署别人的名。
 */
function operatorTag(operatorUid: number): string {
  return `admin:${operatorUid}`;
}

/**
 * 审计明细**不放姓名与护照号**。admin_audit 会原样出现在 /woo 的「最近操作」表里，
 * 那张表不设权限分级、还会被截图。留痕要能回溯，靠的是 verification_id 与材料哈希：
 * 顺着它能查回那条流水（PII 在信封密文里，取它要另过一次 admin 闸门），
 * 而截图本身泄露不了任何一个人的证件信息。
 */
function realnameDetail(
  verificationId: number,
  plan: { materials: { id_page: { sha256: string }; selfie: { sha256: string } } },
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    verification_id: verificationId,
    provider: 'passport',
    material_sha256: [plan.materials.id_page.sha256, plan.materials.selfie.sha256],
    ...extra,
  };
}

/**
 * 通过：落定实名 + 落审计，一个事务。
 *
 * 【为什么把 approvePassportRealname 包在事务里而不是让它自己管】它内部已有一个
 * db.transaction（better-sqlite3 嵌套即 SAVEPOINT，与 adminSetMembership → grantMembership 同款）。
 * 外面再包一层，是为了让**审计与落定同生同死**：审计落了而实名没落，事后看就是
 * 「某人被通过了」而库里查无此事；反过来则是一次没人认领的身份断言。
 *
 * 业务性拒绝（流水不存在 / 不是护照 / 已落定）由 approvePassportRealname 抛出，
 * 在这里被转成 {ok:false}——事务已随抛出整体回滚，所以**审计行也不会留下**。
 */
export function adminApprovePassportRealname(
  db: Database.Database,
  input: { operatorUid: number; verificationId: number; note?: string },
): AdminRealnameResult {
  try {
    return db.transaction((): AdminRealnameResult => {
      const plan = approvePassportRealname(db, {
        verificationId: input.verificationId,
        operator: operatorTag(input.operatorUid),
        note: input.note,
      });
      writeAudit(db, {
        operatorUid: input.operatorUid,
        action: ADMIN_ACTION.approveRealname,
        targetUid: plan.userId,
        detail: realnameDetail(input.verificationId, plan, {
          auth_status: AUTH_STATUS.verified,
          cert_type: CERT_TYPE.passport,
          note: input.note ?? '',
        }),
      });
      return {
        ok: true,
        userId: plan.userId,
        authStatus: AUTH_STATUS.verified,
        certType: CERT_TYPE.passport,
      };
    })();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 驳回：流水转未通过（信封里写下原因）+ users 打回未认证 + 落审计，一个事务。
 *
 * 【原因进审计明细，姓名护照号不进】原因是审核人自己写的一句话，本就要给用户看
 *（用户端 /realname/status 原样回显），不是 PII；它同时是事后判断"这次驳得对不对"的唯一依据。
 */
export function adminRejectPassportRealname(
  db: Database.Database,
  input: { operatorUid: number; verificationId: number; reason: string },
): AdminRealnameResult {
  try {
    return db.transaction((): AdminRealnameResult => {
      const plan = rejectPassportRealname(db, {
        verificationId: input.verificationId,
        operator: operatorTag(input.operatorUid),
        reason: input.reason,
      });
      writeAudit(db, {
        operatorUid: input.operatorUid,
        action: ADMIN_ACTION.rejectRealname,
        targetUid: plan.userId,
        detail: realnameDetail(input.verificationId, plan, {
          auth_status: AUTH_STATUS.none,
          reason: input.reason.trim(),
        }),
      });
      return { ok: true, userId: plan.userId, authStatus: AUTH_STATUS.none };
    })();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
