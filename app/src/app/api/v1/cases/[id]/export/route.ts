// app/src/app/api/v1/cases/[id]/export/route.ts
// GET 导出整案副本（对应 MCP 工具 case_export）。
//
// 【为什么是 GET 而不是 POST】它不改案卷：除了落一份导出件与签一条一次性下载地址，
// 一行档案数据都不动。写成 POST 会让「导出会不会改我的档案」这个问题在接口形状上就
// 答不清楚——而这条端点的用户正是在担心自己的数据。
//
// 【为什么不直接把 zip 字节流回来】包里装着材料原件，可能几十上百兆；一次请求里同步吐完
// 会把这条连接占满，超时重试就整份重打一次。所以照既有导出那条路走：落 files 表 + 签一条
// 一次性限时地址，用户拿浏览器去取（下载路由本来就会流式送字节）。
import { parseId, requireIdentity } from '@/lib/auth/guard';
import { invokeCapability } from '@/lib/capabilities/invoke';
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

  // 走能力那一份实现：实名闸（precondition）与归属校验都由唯一入口统一拦，
  // 路由里另写一句的形态是新开一条端点时忘了抄，而它照常返回 200。
  const outcome = await invokeCapability(getDb(), guard.identity, 'case_export', {
    case_id: caseId,
  });
  if (!outcome.ok) {
    return apiJson(
      { ok: false, error_code: outcome.errorCode, message: outcome.message },
      { status: outcome.status },
    );
  }
  return apiJson({ ok: true, ...outcome.value });
}
