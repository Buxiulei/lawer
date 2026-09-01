// app/src/app/api/v1/admin/users/[uid]/membership/route.ts
// POST  后台调会员档（立即生效；降档 = 当前行提前到期 + 新行）。
// 写入的 memberships.order_no = `admin-<操作者uid>-<时间戳>`，那截前缀就是操作痕：
// 事后从会员行本身就能看出「这一档不是买来的，是某个后台账号手动开的」。
import { NextResponse } from 'next/server';

import { ADMIN_MEMBERSHIP_DAYS, adminOpStamp, adminSetMembership } from '@/lib/admin/actions';
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

  const result = adminSetMembership(db, {
    operatorUid: guard.identity.uid,
    targetUid,
    plan,
    days,
    orderNo: adminOpStamp(guard.identity.uid),
    note: typeof body.note === 'string' ? body.note : '',
  });

  if (!result.ok) {
    // duplicate_order：同一毫秒内同一个管理员点了两次。不静默当成功——那会让第二次
    // 「看起来生效了」而实际什么都没写。让他隔一下再点，下一个时间戳就不撞了。
    if (result.reason === 'duplicate_order') {
      return NextResponse.json(
        { ok: false, error_code: 'OP_TOO_FAST', message: '这一秒已经有一次同样的操作，稍等一下再点' },
        { status: 409 },
      );
    }
    return adminBadRequest('BAD_DAYS', `时长只能是 ${ADMIN_MEMBERSHIP_DAYS.join(' / ')} 天`);
  }

  return NextResponse.json({
    ok: true,
    order_no: result.orderNo,
    plan: result.plan,
    days: result.days,
    downgraded: result.downgraded,
    expires_at: result.expiresAt,
    prev_plan: result.prevPlan,
    prev_expires_at: result.prevExpiresAt,
  });
}
