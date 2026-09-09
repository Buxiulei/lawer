// app/src/app/api/v1/evidence/[id]/extract/route.ts
// POST 发起内容提取。**与 MCP 的 evidence_extract 是同一个 handler**（lib/evidence/extraction）：
// 网页与用户自己的 agent 走同一套闸门与同一套价，两个入口不该有两份实现。
//
// 两步同一个端点：body 不带 quote_id = 报价（免费、不扣任何费用）；带 quote_id = 确认扣费并排队。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { findEvidenceDetail } from '@/lib/db/evidence';
import { EXTRACTION_MODES, quoteExtraction, startExtraction } from '@/lib/evidence/extraction';
import { apiJson } from '@/lib/http/json';
import type { ExtractionMode } from '@/lib/jobs/extraction-worker';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) {
    return apiJson(
      { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '这件材料不存在' },
      { status: 404 },
    );
  }

  let body: { mode?: unknown; quote_id?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // 空 body 等价于「没给 mode」，由下面那条错误统一回话
  }

  const mode = (EXTRACTION_MODES as readonly string[]).includes(body.mode as string)
    ? (body.mode as ExtractionMode)
    : null;
  if (!mode) {
    return apiJson(
      {
        ok: false,
        error_code: 'INVALID_MODE',
        message: `mode 只能是 ${EXTRACTION_MODES.join(' / ')}，收到 ${JSON.stringify(body.mode)}`,
      },
      { status: 400 },
    );
  }

  const userId = guard.identity.uid;
  if (body.quote_id === undefined || body.quote_id === null) {
    const quoted = quoteExtraction(getDb(), { evidenceId, userId, mode });
    if (!quoted.ok) return domainFailure(quoted);
    return apiJson({ ok: true, quote: quoted.quote });
  }

  const quoteId = Number(body.quote_id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) {
    return apiJson(
      { ok: false, error_code: 'INVALID_QUOTE_ID', message: 'quote_id 必须是报价回包里的正整数编号' },
      { status: 400 },
    );
  }
  const started = startExtraction(getDb(), { evidenceId, userId, mode, quoteId });
  if (!started.ok) return domainFailure(started);

  // 只有确认那一步记台账：上面那条报价分支明说「只出价、不动账」，
  // 给它也记一行的形态是——台账里「发起过几次提取」比实际排进队的次数多。
  const caseId = findEvidenceDetail(getDb(), evidenceId)?.case_id;
  if (caseId !== undefined) {
    recordAgentWriteFromRest(getDb(), guard.identity, {
      endpoint: '/api/v1/evidence/{id}/extract',
      method: 'POST',
      caseId,
      targetTable: 'extraction_jobs',
      targetId: started.job_id,
      deduped: started.deduped,
    });
  }
  return apiJson({ ok: true, job: started });
}
