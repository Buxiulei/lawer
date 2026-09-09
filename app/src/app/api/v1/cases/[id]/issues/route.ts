// app/src/app/api/v1/cases/[id]/issues/route.ts
// GET 读争点表（由要件表派生，对应 MCP 工具 issue_list）。
// 与同目录的 elements 一样直接调注册表那条能力的 run，理由见那个文件的抬头。
import { getCapability } from '@/lib/capabilities';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson({ ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' }, { status: 404 });
  }

  const result = await getCapability('issue_list')!.run(getDb(), guard.identity, { case_id: caseId });
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    return domainFailure(result as unknown as Parameters<typeof domainFailure>[0]);
  }
  return apiJson(result as Record<string, unknown>);
}
