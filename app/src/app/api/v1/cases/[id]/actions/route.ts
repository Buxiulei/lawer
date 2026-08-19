// app/src/app/api/v1/cases/[id]/actions/route.ts
// GET 列出行动卡，可用 ?status= 过滤（对应 MCP 工具 action_list）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
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
