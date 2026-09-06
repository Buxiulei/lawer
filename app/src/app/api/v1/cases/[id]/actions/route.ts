// app/src/app/api/v1/cases/[id]/actions/route.ts
// GET 列出行动卡，可用 ?status= 过滤（对应 MCP 工具 action_list）。
// POST 新建行动卡（对应 MCP 工具 action_create）：张数上限、三样必填、同题去重
// 全在那条能力里，本路由只把 case_id 与请求体交上去——照抄一遍的形态是
// 两条入口的去重口径悄悄分叉，而两边都返回 200。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { runCapabilityRest } from '@/lib/capabilities/rest-runner';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const status = new URL(req.url).searchParams.get('status');
  const result = cases.listActions(getDb(), {
    caseId,
    userId: guard.identity.uid,
    status: status ?? undefined,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, actions: result.actions });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  // case_id 以路径为准：体里再写一个别的编号也不作数，否则同一次调用有两个案件编号，
  // 而只有一个会被用上。
  return runCapabilityRest(req, 'action_create', { ...body, case_id: caseId });
}
