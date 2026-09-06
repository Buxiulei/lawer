// app/src/app/api/v1/auth/email/register/verify/route.ts
// POST /api/v1/auth/email/register/verify  {email, code}
//   → {ok, token, is_new_user, onboarding?: {case_id, is_new}}
//
// **匿名路由，不收 Authorization**：这一步才发出登录态。查无此邮箱即建号（无手机号，
// 注册赠送与建号同事务），已有则直接登录；onboarding 告诉前端进站后落在哪个案件。
import { verifyEmailRegisterCode } from '@/lib/auth';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = verifyEmailRegisterCode(getDb(), {
    email: stringField(body, 'email'),
    code: stringField(body, 'code'),
    // 建哪个领域的案子。**空串当没给**（落缺省领域）：页面在只有一个领域可选时
    // 根本不摆那个控件，此时不该硬塞一个 key 进来。开着没开由服务端复核。
    domain: stringField(body, 'domain') || undefined,
  });
  if (!result.ok) return failureResponse(result);

  return apiJson({
    ok: true,
    token: result.token,
    is_new_user: result.isNewUser,
    ...(result.onboarding
      ? { onboarding: { case_id: result.onboarding.caseId, is_new: result.onboarding.isNew } }
      : {}),
  });
}
