// app/src/app/api/v1/admin/realname/[id]/approve/route.ts
// POST /api/v1/admin/realname/:id/approve   body: { note?: string }
//
// 人工核过材料后落定实名：users 转「已实名」+ 回填姓名/护照号/cert_type=护照，流水转「已实名」。
// 落定与审计在同一个事务（lib/admin/actions），发信在事务之外、尽力而为。
//
// 【为什么不做幂等键】会员与公道值那两条要 op_ref，是因为重试会**再发一份**（钱翻倍）。
// 这条不会：approve 走 planPassportApproval，非「待审」的流水直接抛错 ⇒
// 第二次点击拿到的是 400 BAD_STATE，而不是第二次落定。重复提交在这里天然是幂等的。
import { NextResponse } from 'next/server';

import { adminApprovePassportRealname } from '@/lib/admin/actions';
import {
  adminBadRequest,
  adminConflict,
  adminNotFound,
  adminServerError,
  requireAdmin,
} from '@/lib/admin/auth';
import { notifyRealnameReviewed } from '@/lib/admin/realname-notify';
import { readPassportEnvelope } from '@/lib/auth/passport-realname';
import { parseId } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { latestVerificationIdForUser } from '@/lib/db/realname';

/** 备注/驳回原因的字数上限（与 reject 路由同一个数）。 */
const MAX_REVIEW_TEXT = 500;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const id = parseId((await params).id);
  if (id === null) return adminNotFound();

  // 先确认这条流水存在且是护照通道：不存在与"存在但已落定"必须分成 404 / 400 两种回答，
  // 否则管理员分不清自己是点错了行还是有人抢先审过了。
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

  // 【为什么还要比一次 MAX(id)】管理员手上那张队列是快照。他打开之后、点「通过」之前，
  // 这个人可能又交了一份新材料——旧行仍是「待审」，approve 会**成功落定**，
  // 而 /realname/status 只认最新那行，用户界面继续显示「等待人工核验」。
  // 不报错、不崩，两边各看各的。409 让操作者先刷新，再决定要不要审。
  if (latestVerificationIdForUser(db, record.userId) !== id) {
    return adminConflict(
      'STALE_VERIFICATION',
      '这条不是该用户最新一次提交（他在你打开这一页之后又交了一份）。请刷新队列后再审。',
    );
  }

  const body = (await readJsonBody(req)) ?? {};
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  // 备注会原样进审计明细。不设上限的字段迟早会被粘进一整份聊天记录，
  // 而审计表是要给人翻的——一行 10 万字的备注等于把这张表读废。
  if (note.length > MAX_REVIEW_TEXT) {
    return adminBadRequest('BAD_NOTE', `备注最多 ${MAX_REVIEW_TEXT} 字`);
  }

  const result = adminApprovePassportRealname(db, {
    operatorUid: guard.identity.uid,
    verificationId: id,
    note,
  });
  if (!result.ok) return adminBadRequest('BAD_STATE', result.reason);

  // 发信在 DB 已提交之后，且吞掉一切失败：SMTP 没配好不该让一次已经生效的审核看起来失败了。
  const notified = await notifyRealnameReviewed(db, result.userId);

  return NextResponse.json({
    ok: true,
    user_id: result.userId,
    cert_type: result.certType,
    auth_status: result.authStatus,
    notified,
  });
}
