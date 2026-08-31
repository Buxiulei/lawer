// app/src/app/api/v1/auth/email/register/verify/route.ts
// POST /api/v1/auth/email/register/verify  {email, code}
//   → {ok, token, is_new_user, onboarding?: {case_id, is_new}}
//
// **匿名路由，不收 Authorization**：这一步才发出登录态。查无此邮箱即建号（无手机号，
// 注册赠送与建号同事务），已有则直接登录；onboarding 告诉前端进站后落在哪个案件。
import { NextResponse } from 'next/server';

import { verifyEmailRegisterCode } from '@/lib/auth';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = verifyEmailRegisterCode(getDb(), {
    email: stringField(body, 'email'),
    code: stringField(body, 'code'),
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    token: result.token,
    is_new_user: result.isNewUser,
    ...(result.onboarding
      ? { onboarding: { case_id: result.onboarding.caseId, is_new: result.onboarding.isNew } }
      : {}),
  });
}
