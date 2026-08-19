// app/src/app/api/v1/auth/email/verify/route.ts
// POST /api/v1/auth/email/verify  {email, code}，需 Authorization: Bearer <token> → {ok, token}
// 返回的是换发的新 token；此时该账号手机 + 邮箱双验证已齐（spec §8）。
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

  return NextResponse.json({ ok: true, token: result.token });
}
