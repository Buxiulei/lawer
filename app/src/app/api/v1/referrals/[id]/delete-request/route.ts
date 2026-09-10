// app/src/app/api/v1/referrals/[id]/delete-request/route.ts
// POST 要求删除一条已经发出去的转介（对应 MCP 工具 referral_delete_request，协议九.3）。
//
// 【为什么是 POST 到一个子资源，而不是 DELETE 这条转介】被删的东西不在我们这边：
// 转介一经发出就到了对方那里，我们能做的是**记下并转达一个请求**。用 DELETE
// 会让调用方以为这一下就把对方那边的记录抹掉了——而回包 200 更坐实了这个误解。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { invokeCapability } from '@/lib/capabilities/invoke';
import { getDb } from '@/lib/db/client';
import { findReferralById } from '@/lib/db/referrals';
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
  // 台账按案件归档，而删除请求的回包只带 referral_id；回读一次那条转介取案件号。
  // 读不到就不记（那条转介在这一瞬被清了）——不拿一个猜出来的案件号占位。
  const caseId = findReferralById(getDb(), referralId)?.case_id;
  if (caseId !== undefined) {
    recordAgentWriteFromRest(getDb(), guard.identity, {
      endpoint: '/api/v1/referrals/{id}/delete-request',
      method: 'POST',
      caseId,
      targetTable: 'referrals',
      targetId: referralId,
      deduped: outcome.value.already_requested === true,
    });
  }
  return apiJson({ ok: true, ...outcome.value });
}
