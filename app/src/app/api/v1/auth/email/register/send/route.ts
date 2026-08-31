// app/src/app/api/v1/auth/email/register/send/route.ts
// POST /api/v1/auth/email/register/send  {email} → {ok, ttl_seconds, retry_after}
//
// **匿名路由，不收 Authorization**——它是开户入口，调用它的人本来就还没有账号。
// 与隔壁 /auth/email/send 的区别只在闸门语义（那条是「已登录的人补绑邮箱」，要 Bearer），
// 两者用的验证码分属不同 purpose、互不通用；限流则按邮箱聚合，见 lib/db/otp.ts。
import { NextResponse } from 'next/server';

import { extractClientIp, sendEmailRegisterCode } from '@/lib/auth';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = await sendEmailRegisterCode(getDb(), {
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
