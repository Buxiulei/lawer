// app/src/app/api/v1/me/cancel/route.ts
// POST 注销账号（协议五.9，附一第 7 项）。
//
// 【只认网页登录态】与 api key 管理那几条同一条规矩：不能用一把 key 把自己的账号注销掉。
// 一把被泄露的长期凭据能做的最坏的事，不该包括「把这个人的全部档案推进删除流程」。
//
// 【两步在同一条端点上】不带 code = 出确认单并把验证码发出去（零删除）；
// 带 confirm_token + code = 执行。分成两条端点的形态是：第一条的返回值里那份
//「会删什么、会留什么」清单与第二条真正执行的东西各自演化，而两边都不报错。
import { requireWebSession } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';
import { cancelAccount } from '@/lib/lifecycle/account-cancel';

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const body = (await readJsonBody(req)) ?? {};
  const outcome = await cancelAccount({
    db: getDb(),
    userId: guard.identity.uid,
    code: body.code,
    confirmToken: body.confirm_token,
  });
  if (!outcome.ok) {
    return apiJson(
      { ok: false, error_code: outcome.errorCode, message: outcome.message },
      { status: outcome.status },
    );
  }
  return apiJson(outcome);
}
