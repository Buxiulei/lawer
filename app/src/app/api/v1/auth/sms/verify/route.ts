// app/src/app/api/v1/auth/sms/verify/route.ts
// POST /api/v1/auth/sms/verify  {phone, code} → {ok, token, need_email}
// need_email=true 表示该账号还没验过邮箱，前端应接着走 /auth/email/send（spec §8 双验证）。
import { NextResponse } from 'next/server';

import { verifyPhoneCode } from '@/lib/auth';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = verifyPhoneCode(getDb(), {
    phone: stringField(body, 'phone'),
    code: stringField(body, 'code'),
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({ ok: true, token: result.token, need_email: result.needEmail });
}
