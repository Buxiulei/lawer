// app/src/app/api/v1/cases/[id]/company-graph/route.ts
// GET 本案的公司关系图谱。响应 { ok: true, graph: CompanyGraph | null }——
// graph 为 null 表示这案还没做过公司调查（不是错误，界面走空状态）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { buildCompanyGraph } from '@/lib/graph/build';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  // 归属校验走 lib/cases 的既有入口，不在这里另写一遍 user_id 比对：
  // 「非本人案件一律当作不存在」是条红线（lib/cases/index.ts 文件头），
  // 红线复制第二份的那天，两份就开始各自演化了。
  const owned = cases.getCase(getDb(), {
    caseId,
    userId: guard.identity.uid,
    timelineLimit: 1,
  });
  if (!owned.ok) return domainFailure(owned);

  return NextResponse.json({ ok: true, graph: buildCompanyGraph(getDb(), caseId) });
}
