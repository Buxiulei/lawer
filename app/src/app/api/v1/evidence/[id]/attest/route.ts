// app/src/app/api/v1/evidence/[id]/attest/route.ts
// POST 发起证据固化（TSA 时间戳 → 《存证证明》PDF → 签名）。
// 幂等：同一条证据重复 POST 不会产生第二个订单，中途失败的订单会原地续跑。
// 需已实名：出证结果要与本人身份绑定（见 lib/auth/guard.ts requireRealname 的范围说明）。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity, requireRealname } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { findEvidenceDetail } from '@/lib/db/evidence';
import * as evidence from '@/lib/evidence';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const gate = await requireRealname(getDb(), guard.identity);
  if (!gate.ok) return gate.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) {
    return apiJson(
      { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' },
      { status: 404 },
    );
  }

  const result = await evidence.attestEvidence(getDb(), {
    evidenceId,
    userId: guard.identity.uid,
  });
  if (!result.ok) return domainFailure(result);

  // 出证回的是 attestations 那一行，它自己不带 case_id；台账要按案件归档，所以回读一次证据行。
  // 读不到就不记（证据行在这一瞬被删掉了）——宁可缺一行审计，也不拿一个猜出来的案件号占位。
  const caseId = findEvidenceDetail(getDb(), evidenceId)?.case_id;
  if (caseId !== undefined) {
    recordAgentWriteFromRest(getDb(), guard.identity, {
      endpoint: '/api/v1/evidence/{id}/attest',
      method: 'POST',
      caseId,
      targetTable: 'attestations',
      targetId: result.attestation.id,
    });
  }

  return apiJson({ ok: true, attestation: result.attestation });
}
