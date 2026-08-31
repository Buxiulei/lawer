// app/src/app/api/v1/auth/email/send/route.ts
// POST /api/v1/auth/email/send  {email} → {ok, ttl_seconds, retry_after}
//
// Authorization 头**可选**，两种用法：
//   带有效 token = 注册补全（手机验证刚建的号来绑邮箱，/sms/verify 那次已发 token）；
//   不带头       = 邮箱通道登录，只对已经绑过并验证过的邮箱有效（否则 404 EMAIL_NOT_REGISTERED）。
// 带了但不作数（伪造 / 过期）一律 401，不降级成匿名——见 lib/auth/http.ts optionalUserId。
import { NextResponse } from 'next/server';

import { extractClientIp, sendEmailCode } from '@/lib/auth';
import {
  badRequest,
  failureResponse,
  optionalUserId,
  readJsonBody,
  stringField,
  unauthorized,
} from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const userId = optionalUserId(req.headers.get('authorization'));
  if (userId === 'invalid') return unauthorized();

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = await sendEmailCode(getDb(), {
    userId,
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
