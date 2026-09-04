// app/src/app/api/v1/cases/[id]/timeline/route.ts
// POST 追加一条时间线事件（对应 MCP 工具 timeline_add）。只追加，无改无删。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
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

  const result = cases.addTimelineEvent(getDb(), {
    caseId,
    userId: guard.identity.uid,
    happenedAt: body.happened_at,
    kind: body.kind,
    title: body.title,
    detail: body.detail,
    clientRef: body.client_ref,
  });
  if (!result.ok) return domainFailure(result);

  // deduped=true 时这条是既有行（同 client_ref 重放或近重复），没有新插入——回 200；
  // 真新增回 201。调用方据此知道「这条已经记过了」，不必再向用户复述一遍。
  return NextResponse.json(
    { ok: true, event: result.event, deduped: result.deduped },
    { status: result.deduped ? 200 : 201 },
  );
}
