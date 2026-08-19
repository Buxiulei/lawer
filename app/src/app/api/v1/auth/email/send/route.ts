// app/src/app/api/v1/auth/email/send/route.ts
// POST /api/v1/auth/email/send  {email}，需 Authorization: Bearer <token> → {ok, ttl_seconds, retry_after}
//
// 为什么要带 token：邮箱验证是「已经过手机验证的用户补第二因子」，不是独立注册入口。
// 手机验证通过后 /sms/verify 就已发 token（此时 need_email=true），拿它来调本接口即可。
import { NextResponse } from 'next/server';

import { extractClientIp, sendEmailCode, verifyAuthHeader } from '@/lib/auth';
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

  const result = await sendEmailCode(getDb(), {
    userId: payload.uid,
    email: stringField(body, 'email'),
    ip: extractClientIp(req.headers),
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    ttl_seconds: result.ttlSeconds,
    retry_after: result.retryAfter,
  });
}
