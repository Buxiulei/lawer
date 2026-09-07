// app/src/app/api/v1/referrals/[id]/delete-request/route.ts
// POST 要求删除一条已经发出去的转介（对应 MCP 工具 referral_delete_request，协议九.3）。
//
// 【为什么是 POST 到一个子资源，而不是 DELETE 这条转介】被删的东西不在我们这边：
// 转介一经发出就到了对方那里，我们能做的是**记下并转达一个请求**。用 DELETE
// 会让调用方以为这一下就把对方那边的记录抹掉了——而回包 200 更坐实了这个误解。
import { parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { invokeCapability } from '@/lib/capabilities/invoke';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const referralId = parseId((await params).id);
  if (referralId === null) {
    return apiJson(
      { ok: false, error_code: 'REFERRAL_NOT_FOUND', message: '转介记录不存在' },
      { status: 404 },
    );
  }

  // 体可以没有（reason 是选填）：读不出 JSON 时按「没给理由」办，不因此拒收一次撤回请求。
  const body = (await readJsonBody(req)) ?? {};
  const outcome = await invokeCapability(getDb(), guard.identity, 'referral_delete_request', {
    referral_id: referralId,
    reason: (body as Record<string, unknown>).reason,
  });
  if (!outcome.ok) {
    return apiJson(
      { ok: false, error_code: outcome.errorCode, message: outcome.message },
      { status: outcome.status },
    );
  }
  return apiJson({ ok: true, ...outcome.value });
}
