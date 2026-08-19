// app/src/app/api/v1/cases/[id]/evidence/route.ts
// GET 列出证据条目（对应 MCP 工具 evidence_list）。
// 只列元数据，不返回文件内容或落盘路径——取文件走证据窗口的下载接口（M2）。
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

  const result = cases.listEvidence(getDb(), { caseId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, evidence: result.evidence });
}
