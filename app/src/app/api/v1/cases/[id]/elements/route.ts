// app/src/app/api/v1/cases/[id]/elements/route.ts
// GET 读要件表：每一项已登记诉求各靠哪几个要件成立、状态、该谁举证、缺什么
// （对应 MCP 工具 element_sheet_get）。
//
// 【为什么直接调注册表里那条能力的 run，而不再写一遍取数】要件表的取数有三处容易分叉的地方
//（按整案取时间线而不是快照窗口、按已登记诉求过滤、burden 的用户可见措辞由领域包给）。
// 照抄一份的形态是：某次改口径只改了其中一条入口，MCP 与 REST 两侧各返回一张不同的要件表，
// 而两边都是 200。
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

  const url = new URL(req.url);
  const result = await getCapability('element_sheet_get')!.run(getDb(), guard.identity, {
    case_id: caseId,
    claim_kind: url.searchParams.get('claim_kind') ?? undefined,
  });
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    return domainFailure(result as unknown as Parameters<typeof domainFailure>[0]);
  }
  return apiJson(result as Record<string, unknown>);
}
