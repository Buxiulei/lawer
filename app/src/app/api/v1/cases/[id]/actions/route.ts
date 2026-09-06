// app/src/app/api/v1/cases/[id]/actions/route.ts
// GET 列出行动卡，可用 ?status= 过滤，分页（对应 MCP 工具 action_list）。
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as cases from '@/lib/cases';
import { pageParams, pageResponse } from '@/lib/cases/paging';
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

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const { limit, offset } = pageParams(url);
  const result = cases.listActions(getDb(), {
    caseId,
    userId: guard.identity.uid,
    status: status ?? undefined,
    limit,
    offset,
  });
  if (!result.ok) return domainFailure(result);

  return pageResponse('actions', { items: result.actions, ...result });
}
