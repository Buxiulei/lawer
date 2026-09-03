// app/src/app/api/v1/admin/realname/[id]/reject/route.ts
// POST /api/v1/admin/realname/:id/reject   body: { reason: string }（必填）
//
// 驳回：流水转「未通过」+ 信封里写下谁驳的/何时/为什么，users 打回「未认证」（可重交）。
// 原因原文由 /api/v1/realname/status 回显给用户（设置页的「上一次没通过：…」）。
//
// 【为什么 reason 必填到 400】驳回而不说为什么，用户只能猜着重交，
// 大概率原样再交一次、再被驳一次 —— 一个不说理由的驳回按钮制造的是死循环，不是审核。
import { NextResponse } from 'next/server';

import { adminRejectPassportRealname } from '@/lib/admin/actions';
import {
  adminBadRequest,
  adminNotFound,
  adminServerError,
  requireAdmin,
} from '@/lib/admin/auth';
import { notifyRealnameReviewed } from '@/lib/admin/realname-notify';
import { readPassportEnvelope } from '@/lib/auth/passport-realname';
import { parseId } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const id = parseId((await params).id);
  if (id === null) return adminNotFound();

  let record;
  try {
    record = readPassportEnvelope(db, id);
  } catch (err) {
    return adminServerError(
      'REALNAME_ENVELOPE_BROKEN',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!record) return adminNotFound();

  const body = await readJsonBody(req);
  if (!body) return adminBadRequest('BAD_BODY', '请求体不是合法 JSON');
  // trim 之后为空同样拒：全是空格的"原因"和没写原因，对用户来说是同一件事。
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return adminBadRequest('BAD_REASON', '驳回原因必填：用户会原样看到这句话，据此决定怎么重交');
  }

  const result = adminRejectPassportRealname(db, {
    operatorUid: guard.identity.uid,
    verificationId: id,
    reason,
  });
  if (!result.ok) return adminBadRequest('BAD_STATE', result.reason);

  const notified = await notifyRealnameReviewed(db, result.userId);

  return NextResponse.json({
    ok: true,
    user_id: result.userId,
    auth_status: result.authStatus,
    notified,
  });
}
