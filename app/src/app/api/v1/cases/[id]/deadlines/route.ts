// app/src/app/api/v1/cases/[id]/deadlines/route.ts
// GET 列出法定期限，默认只列生效中的；?include_resolved=1 连已履行/作废的一起列
// （对应 MCP 工具 deadline_list）。
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

  const includeResolved = new URL(req.url).searchParams.get('include_resolved') === '1';
  const result = cases.listDeadlines(getDb(), {
    caseId,
    userId: guard.identity.uid,
    includeResolved,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, deadlines: result.deadlines });
}
