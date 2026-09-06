// app/src/app/api/v1/cases/[id]/evidence/route.ts
// GET 列出证据条目（对应 MCP 工具 evidence_list）。
// 只列元数据，不返回文件内容或落盘路径——取文件走证据窗口的下载接口（M2）。
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  // 已作废的默认不列（与 MCP 的 evidence_list 同一个开关、同一个默认值）：
  // 网页证据库要展示那个折叠区时显式传 include_voided=1。
  const includeVoided = new URL(req.url).searchParams.get('include_voided');
  const result = cases.listEvidence(getDb(), {
    caseId,
    userId: guard.identity.uid,
    includeVoided: includeVoided === '1' || includeVoided === 'true',
  });
  if (!result.ok) return domainFailure(result);

  return apiJson({ ok: true, evidence: result.evidence });
}
