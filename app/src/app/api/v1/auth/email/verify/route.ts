// app/src/app/api/v1/auth/email/verify/route.ts
// POST /api/v1/auth/email/verify  {email, code}，需 Authorization: Bearer <token>
//   → {ok, token, onboarding?: {case_id, is_new}}
// 返回的是换发的新 token；此时该账号手机 + 邮箱双验证已齐（spec §8），服务端顺手把默认案件
// 建好，onboarding 告诉前端该跳去哪个案件（本来就有案件时 is_new=false）。
import { NextResponse } from 'next/server';

import { verifyAuthHeader, verifyEmailCode } from '@/lib/auth';
import {
  badRequest,
  failureResponse,
  readJsonBody,
  stringField,
  unauthorized,
} from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const payload = verifyAuthHeader(req.headers.get('authorization'));
  if (!payload) return unauthorized();

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = verifyEmailCode(getDb(), {
    userId: payload.uid,
    email: stringField(body, 'email'),
    code: stringField(body, 'code'),
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    token: result.token,
    ...(result.onboarding
      ? { onboarding: { case_id: result.onboarding.caseId, is_new: result.onboarding.isNew } }
      : {}),
  });
}
