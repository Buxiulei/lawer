// app/src/app/api/v1/cases/[id]/evidence/route.ts
// GET 列出证据条目，分页（对应 MCP 工具 evidence_list）。
// 只列元数据，不返回文件内容或落盘路径——取文件走证据窗口的下载接口（M2）。
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as cases from '@/lib/cases';
import { pageParams, pageResponse } from '@/lib/cases/paging';
import { getDb } from '@/lib/db/client';
import { briefStatusOf } from '@/lib/evidence/brief';
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
  // 过滤在分页之前：先按开关定下这一条清单有哪些，再切页。反过来的形态是
  // total 把作废的也数进去，而页面上永远凑不满那个数。
  const url = new URL(req.url);
  const includeVoided = url.searchParams.get('include_voided');
  const { limit, offset } = pageParams(url);
  const result = cases.listEvidence(getDb(), {
    caseId,
    userId: guard.identity.uid,
    includeVoided: includeVoided === '1' || includeVoided === 'true',
    limit,
    offset,
  });
  if (!result.ok) return domainFailure(result);

  // 简报处境（none/ok/failed + 原因）由 lib/evidence 的 briefStatusOf 派生——与 MCP
  // evidence_list 用的是**同一个符号**，两条入口不各写一份。各写一份的形态是某天分叉：
  // 一条把 failed 归进 none（`brief_json ? 'ok' : 'none'`），另一条不会，而两边都返回 200。
  const items = result.evidence.map((row) => ({
    ...row,
    ...briefStatusOf(row.brief_json, row.brief_error),
  }));

  return pageResponse('evidence', { ...result, items });
}
