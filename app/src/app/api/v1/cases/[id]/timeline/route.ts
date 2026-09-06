// app/src/app/api/v1/cases/[id]/timeline/route.ts
// POST 追加一条时间线事件（对应 MCP 工具 timeline_add）。只追加，无改无删。
// GET 翻时间线（对应 MCP 工具 timeline_list）。
//
// 【GET 这条是补上的】能力注册表里 timeline_list 一直声明着 `GET /cases/{id}/timeline`，
// 接入说明与 /api/manifest 也照着这份声明告诉对方 agent 可以调它——而磁盘上只有 POST。
// 形态是：说明书上写着的这条端点，调过去 404，而说明书看起来完全正常。
// 由 lib/capabilities/__tests__/openapi.test.ts 的「能力声明的 REST 必须在端点索引里」逮到。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { runCapabilityRest } from '@/lib/capabilities/rest-runner';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  const q = new URL(req.url).searchParams;
  const args: Record<string, unknown> = { case_id: caseId };
  for (const name of ['since', 'kind', 'limit', 'offset'] as const) {
    const value = q.get(name);
    if (value !== null) args[name] = value;
  }
  return runCapabilityRest(req, 'timeline_list', args);
}

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
