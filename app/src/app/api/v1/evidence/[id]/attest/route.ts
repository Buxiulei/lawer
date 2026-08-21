// app/src/app/api/v1/evidence/[id]/attest/route.ts
// POST 发起证据固化（TSA 时间戳 → 《存证证明》PDF → 签名）。
// 幂等：同一条证据重复 POST 不会产生第二个订单，中途失败的订单会原地续跑。
// 需已实名：出证结果要与本人身份绑定（见 lib/auth/guard.ts requireRealname 的范围说明）。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity, requireRealname } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const gate = requireRealname(getDb(), guard.identity);
  if (!gate.ok) return gate.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' },
      { status: 404 },
    );
  }

  const result = await evidence.attestEvidence(getDb(), {
    evidenceId,
    userId: guard.identity.uid,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, attestation: result.attestation });
}
