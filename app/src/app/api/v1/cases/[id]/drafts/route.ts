// app/src/app/api/v1/cases/[id]/drafts/route.ts
// GET 列出案件下的文书（对话里 draft_write 落的那些）。正文一并返回：文书页打开就要读全文。
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

  const result = cases.listDrafts(getDb(), { caseId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, drafts: result.drafts });
}
