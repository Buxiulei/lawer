// app/src/app/api/v1/evidence/[id]/void/route.ts
// POST 作废一件材料（对应 MCP 工具 evidence_void）。判断全在 lib/evidence/void，本文件只解参。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { voidEvidence } from '@/lib/evidence/void';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) {
    return apiJson(
      { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '这件材料不存在，或不属于本人' },
      { status: 404 },
    );
  }

  const body = (await readJsonBody(req)) ?? {};
  const result = voidEvidence(getDb(), {
    evidenceId,
    userId: guard.identity.uid,
    reason: typeof body.reason === 'string' ? body.reason : '',
  });
  if (!result.ok) return domainFailure(result);

  // deduped 取「这次没改动任何字段」——作废两次只在台账里留两行调用记录，
  // 而第二行明说它是重放，不会被读成「又作废了一件」。
  recordAgentWriteFromRest(getDb(), guard.identity, {
    endpoint: '/api/v1/evidence/{id}/void',
    method: 'POST',
    caseId: result.case_id,
    targetTable: 'evidence',
    targetId: result.evidence_id,
    deduped: result.previous_status === result.status,
  });
  return apiJson(result);
}
