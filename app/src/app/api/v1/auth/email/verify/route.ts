// app/src/app/api/v1/auth/email/verify/route.ts
// POST /api/v1/auth/email/verify  {email, code} → {ok, token, onboarding?: {case_id, is_new}}
//
// Authorization 头**可选**，语义与 /email/send 一致（注册补全 / 邮箱通道登录），
// 带了坏 token 一律 401 而不降级成匿名。返回的是换发的新 token。
// 注册补全那一路走完时手机 + 邮箱双验证已齐（spec §8），服务端顺手把默认案件建好，
// onboarding 告诉前端该跳去哪个案件（本来就有案件时 is_new=false）。
import { verifyEmailCode } from '@/lib/auth';
import {
  badRequest,
  failureResponse,
  optionalUserId,
  readJsonBody,
  stringField,
  unauthorized,
} from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request) {
  const userId = optionalUserId(req.headers.get('authorization'));
  if (userId === 'invalid') return unauthorized();

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = verifyEmailCode(getDb(), {
    userId,
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
    ...(result.onboarding
      ? { onboarding: { case_id: result.onboarding.caseId, is_new: result.onboarding.isNew } }
      : {}),
  });
}
