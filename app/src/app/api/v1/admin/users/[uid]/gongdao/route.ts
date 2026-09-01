// app/src/app/api/v1/admin/users/[uid]/gongdao/route.ts
// POST  后台发公道值。**必走 lib/billing 唯一入口**（gongdaoGrant），本文件不碰账本表。
//
// 【op_ref 为什么可以由前端给】refId 是幂等键。若每个请求都由服务端现生成一个随机 ref，
// 那"同 refId 只发一次"就只在 lib 的单测里成立，生产上一次网络重试照样发两笔。
// 前端在**弹出确认框那一刻**生成一个 ref 并在重试中复用，重复提交才真的被挡下。
// 形状受 isAdminGrantRef 约束（必须是本操作者的操作痕），一个管理员无法把动作记到别人头上。
import { NextResponse } from 'next/server';

import {
  adminGrantGongdao,
  isAdminGrantRef,
  newAdminGrantRef,
} from '@/lib/admin/actions';
import { adminBadRequest, adminNotFound, requireAdmin } from '@/lib/admin/auth';
import { parseId } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
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

  const delta = Number(body.delta);
  if (!Number.isInteger(delta) || delta <= 0) {
    return adminBadRequest('BAD_AMOUNT', '数额要填正整数');
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) return adminBadRequest('BAD_NOTE', '备注必填：事后要靠它解释这笔为什么发');

  const opRef = typeof body.op_ref === 'string' ? body.op_ref : '';
  if (opRef && !isAdminGrantRef(opRef, guard.identity.uid)) {
    return adminBadRequest('BAD_OP_REF', '幂等键形状不对');
  }
  const refId = opRef || newAdminGrantRef(guard.identity.uid);

  const result = adminGrantGongdao(db, {
    operatorUid: guard.identity.uid,
    targetUid,
    delta,
    note,
    refId,
  });
  if (!result.ok) return adminBadRequest('BAD_AMOUNT', '数额要填正整数');

  return NextResponse.json({
    ok: true,
    ref_id: result.refId,
    delta: result.delta,
    balance: result.balance,
    // applied=false 表示这个 refId 已经发过一次：本次没有再入账，余额是原来那个。
    // 前端要把这句话说出来，别显示成"又发了一笔"。
    applied: result.applied,
  });
}
