// app/src/app/api/v1/cases/[id]/claims/route.ts
// GET 列出诉求清单与合计金额（对应 MCP 工具 claims_list）。
// 合计由服务端算：路由不把各项加一遍——加第二遍的形态是两处口径悄悄分叉，
// 而拿去谈的正是这个总数。

import { parseId } from '@/lib/auth/guard';
import { runCapabilityRest } from '@/lib/capabilities/rest-runner';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  return runCapabilityRest(req, 'claims_list', { case_id: caseId });
}
