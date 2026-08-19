// app/src/app/api/v1/cases/[id]/route.ts
// GET   案件档案 + 最近时间线（对应 MCP 工具 case_get）
// PATCH 更新 stage / goal / bottom_line（对应 case_update）
// 与 MCP 工具共用同一批 lib/cases 函数，两条入口行为逐字一致。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get('timeline_limit');
  const result = cases.getCase(getDb(), {
    caseId,
    userId: guard.identity.uid,
    timelineLimit: rawLimit === null ? undefined : Number(rawLimit),
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, case: result.case, timeline: result.timeline });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = cases.updateCase(getDb(), {
    caseId,
    userId: guard.identity.uid,
    stage: body.stage,
    goal: body.goal,
    bottomLine: body.bottom_line,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, case: result.case });
}
