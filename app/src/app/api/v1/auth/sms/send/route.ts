// app/src/app/api/v1/auth/sms/send/route.ts
// POST /api/v1/auth/sms/send  {phone} → {ok, ttl_seconds, retry_after}
import { NextResponse } from 'next/server';

import { extractClientIp, sendPhoneCode } from '@/lib/auth';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const result = await sendPhoneCode(getDb(), {
    phone: stringField(body, 'phone'),
    ip: extractClientIp(req.headers),
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    ttl_seconds: result.ttlSeconds,
    retry_after: result.retryAfter,
  });
}
