// app/src/app/api/v1/cases/[id]/report/route.ts
// GET 读个案报告（对应 MCP 工具 case_report_get）。网页档案页只读这一条。
// 首次读会惰性生成初稿——所以这条 GET 会写库，这是有意的（设计稿 §4.3）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as report from '@/lib/cases/report';
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

  const section = new URL(req.url).searchParams.get('section');
  const result = report.getReport(getDb(), { caseId, userId: guard.identity.uid, section });
  if (!result.ok) return domainFailure(result);
  return NextResponse.json(result);
}
