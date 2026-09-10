// app/src/app/api/v1/cases/[id]/actions/[actionId]/route.ts
// PATCH 把行动卡标成「完成」（默认）或「放弃」（对应 MCP 工具 action_complete）。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const { id, actionId: rawActionId } = await params;
  const caseId = parseId(id);
  const actionId = parseId(rawActionId);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  if (actionId === null) {
    return apiJson(
      { ok: false, error_code: 'ACTION_NOT_FOUND', message: '行动项不存在' },
      { status: 404 },
    );
  }

  // body 可省略，省略即表示标记为「完成」
  const body = (await readJsonBody(req)) ?? {};
  const result = cases.setActionStatus(getDb(), {
    caseId,
    userId: guard.identity.uid,
    actionId,
    status: body.status,
  });
  if (!result.ok) return domainFailure(result);

  recordAgentWriteFromRest(getDb(), guard.identity, {
    endpoint: '/api/v1/cases/{id}/actions/{actionId}',
    method: 'PATCH',
    caseId,
    targetTable: 'action_items',
    targetId: actionId,
  });

  return apiJson({ ok: true, action: result.action });
}
