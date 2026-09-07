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
    // 建哪个领域的案子。**空串当没给**（落缺省领域）：空串是"这一格没有值"，
    // 不是"某个领域"，两边同一条口径，谁都不必猜另一边怎么理解一个空字符串。
    // 页面在只有一个领域可选时不摆控件，但**照样会把那唯一的一项填进来**
    // （app/_ui/DomainChoice.submittedDomain）——不摆控件是因为没什么可问的，
    // 不是因为没有答案。开着没开由服务端复核。
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
