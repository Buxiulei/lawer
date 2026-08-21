// app/src/app/api/v1/realname/status/route.ts
// GET /api/v1/realname/status，需 Authorization: Bearer <jwt>
//   → {ok, auth_status, verification_status, message}
// 阿里云不回调，只能轮询；落定后重复调用直接回存量结论，不再打阿里云（见 refreshRealnameStatus）。
import { NextResponse } from 'next/server';

import { requireWebSession } from '@/lib/auth/guard';
import { failureResponse } from '@/lib/auth/http';
import { refreshRealnameStatus } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const result = await refreshRealnameStatus(getDb(), { userId: guard.identity.uid });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    auth_status: result.authStatus,
    verification_status: result.verificationStatus,
    message: result.message,
  });
}
