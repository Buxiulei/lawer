// app/src/app/api/v1/admin/users/[uid]/membership/route.ts
// POST  后台调会员档（立即生效；降档 = 当前行提前到期 + 新行）。
// 写入的 memberships.order_no = `admin-<操作者uid>-<时间戳>`，那截前缀就是操作痕：
// 事后从会员行本身就能看出「这一档不是买来的，是某个后台账号手动开的」。
//
// 【op_ref（幂等键）为什么由前端给】order_no 就是跨请求幂等键。若每次都由服务端现生成毫秒戳，
// 「同 order_no 只写一行」只在 lib 单测里成立，生产上一次网络重试照样叠出第二行——365 天变 730。
// 前端在**弹确认框那一刻**生成一个 op_ref 并在重试中复用，服务端拿它当 order_no，重复提交才真被挡下。
// 形状受 isAdminGrantRef 约束（必须是本操作者的操作痕，与发公道值同构），冒充他人→400。
// 缺省（非前端直连、无 op_ref）退回服务端 stamp，不改既有非幂等调用方的行为。
import { NextResponse } from 'next/server';

import {
  ADMIN_MEMBERSHIP_DAYS,
  adminOpStamp,
  adminSetMembership,
  isAdminGrantRef,
} from '@/lib/admin/actions';
import { adminBadRequest, adminNotFound, requireAdmin } from '@/lib/admin/auth';
import { readJsonBody } from '@/lib/auth/http';
import { parseId } from '@/lib/auth/guard';
import { MEMBERSHIP, type MembershipPlan } from '@/lib/billing/pricing';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const targetUid = parseId((await params).uid);
  if (targetUid === null) return adminBadRequest('BAD_TARGET', '目标 uid 不合法');
  const exists = db.prepare('SELECT 1 AS x FROM users WHERE id=?').get(targetUid);
  if (!exists) return adminNotFound();

  const body = await readJsonBody(req);
  if (!body) return adminBadRequest('BAD_BODY', '请求体不是合法 JSON');

  const plan = body.plan as MembershipPlan;
  if (!Object.prototype.hasOwnProperty.call(MEMBERSHIP, plan)) {
    return adminBadRequest('BAD_PLAN', '档位只能是 entry / standard / pro');
  }
  const days = Number(body.days);
  if (!(ADMIN_MEMBERSHIP_DAYS as readonly number[]).includes(days)) {
    return adminBadRequest('BAD_DAYS', `时长只能是 ${ADMIN_MEMBERSHIP_DAYS.join(' / ')} 天`);
  }

  const opRef = typeof body.op_ref === 'string' ? body.op_ref : '';
  if (opRef && !isAdminGrantRef(opRef, guard.identity.uid)) {
    return adminBadRequest('BAD_OP_REF', '幂等键形状不对');
  }

  const result = adminSetMembership(db, {
    operatorUid: guard.identity.uid,
    targetUid,
    plan,
    days,
    orderNo: opRef || adminOpStamp(guard.identity.uid),
    note: typeof body.note === 'string' ? body.note : '',
  });

  if (!result.ok) {
    return adminBadRequest('BAD_DAYS', `时长只能是 ${ADMIN_MEMBERSHIP_DAYS.join(' / ')} 天`);
  }

  return NextResponse.json({
    ok: true,
    order_no: result.orderNo,
    plan: result.plan,
    days: result.days,
    downgraded: result.downgraded,
    // applied=false 表示这个 order_no 此前已经调整过：本次没有再写行，会员态是原来那个。
    // 前端要把这句话说出来，别显示成「又调了一次」。
    applied: result.applied,
    expires_at: result.expiresAt,
    prev_plan: result.prevPlan,
    prev_expires_at: result.prevExpiresAt,
  });
}
