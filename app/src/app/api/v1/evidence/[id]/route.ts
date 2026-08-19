// app/src/app/api/v1/evidence/[id]/route.ts
// GET 单条证据详情（含其存证订单，如果已发起过固化）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';

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

  return NextResponse.json({
    ok: true,
    evidence: result.evidence,
    attestation: result.attestation,
  });
}
