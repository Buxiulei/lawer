// app/src/app/api/v1/cases/[id]/timeline/[eventId]/milestone/route.ts
// POST 给一条时间线事件盖上里程碑（批 6 驾驶舱，契约 docs/contracts/case-milestone.md §四）。
//
// 【为什么是独立端点而不是 POST /timeline 的一个字段】契约 §六·二：通用写路径
// （创建事件）在类型上就不该设得了 milestone，"无确认不写"才不是一条靠人记得的纪律。
// 于是流程必然是两步：事件先存在，用户确认后再由本端点盖章。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const { id, eventId: rawEventId } = await params;
  const caseId = parseId(id);
  const eventId = parseId(rawEventId);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  if (eventId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'EVENT_NOT_FOUND', message: '时间线事件不存在' },
      { status: 404 },
    );
  }

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = cases.confirmMilestone(getDb(), {
    caseId,
    userId: guard.identity.uid,
    eventId,
    milestone: body.milestone,
    userConfirmed: body.user_confirmed,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, event: result.event });
}
