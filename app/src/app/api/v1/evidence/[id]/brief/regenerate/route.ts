// app/src/app/api/v1/evidence/[id]/brief/regenerate/route.ts
// POST 重新生成一件材料的简报（对应 MCP 工具 evidence_brief_regenerate）。
// 免费、同步、不排队；判断全在 lib/evidence/extraction.regenerateBrief。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { findEvidenceDetail } from '@/lib/db/evidence';
import { regenerateBrief } from '@/lib/evidence/extraction';
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

  const result = await regenerateBrief(getDb(), { evidenceId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  const caseId = findEvidenceDetail(getDb(), evidenceId)?.case_id;
  if (caseId !== undefined) {
    recordAgentWriteFromRest(getDb(), guard.identity, {
      endpoint: '/api/v1/evidence/{id}/brief/regenerate',
      method: 'POST',
      caseId,
      targetTable: 'evidence',
      targetId: result.evidence_id,
    });
  }
  return apiJson(result);
}
