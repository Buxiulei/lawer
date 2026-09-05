// app/src/app/api/v1/evidence/[id]/route.ts
// GET 单条证据详情（含其存证订单，如果已发起过固化）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';
import { getEvidenceExtraction } from '@/lib/evidence/extraction';

const NOT_FOUND = NextResponse.json(
  { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' },
  { status: 404 },
);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) return NOT_FOUND;

  const result = evidence.getEvidence(getDb(), { evidenceId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  // 提取状态与简报走同一次请求带回来：详情页一打开就要显示它们，
  // 分成第二个请求只会让面板先画一遍"未提取"再跳成"已提取"。
  const extraction = getEvidenceExtraction(getDb(), {
    evidenceId,
    userId: guard.identity.uid,
    includeText: true,
  });
  return NextResponse.json({
    ok: true,
    evidence: result.evidence,
    attestation: result.attestation,
    extraction: extraction.ok ? extraction.evidence : null,
  });
}
