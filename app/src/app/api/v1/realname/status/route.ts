// app/src/app/api/v1/realname/status/route.ts
// GET /api/v1/realname/status
//   网页登录态 → {ok, auth_status, verification_status, method, message}（会去上游拉一次结果）
//   api key    → {ok, auth_status} 只读三态，不回姓名证件、也不打上游
//
// 阿里云不回调，只能轮询；落定后重复调用直接回存量结论，不再打阿里云（见 refreshRealnameStatus）。
//
// 【为什么 api key 要能读到】未实名时证据登记、固化出证一律回 REALNAME_REQUIRED。
// 此前这条端点只认网页登录态，agent 拿不到自己账号的实名状态，只能靠**发一次会失败的写入**
// 去试探——试探本身有副作用（占幂等键、写日志），而且失败之后它也说不清是没实名还是别的原因。
// 【为什么不校 scope】回的是本人账号的一个三态，不含任何案件数据，与 /api/v1/agent-setup 同档；
// 而且要它的恰恰是只有 case:write 的那种 key（写之前先看闸门过不过）。
// 【为什么 key 这条不打上游】拉取会写回 users、消耗上游配额，还可能把「待审」推进成落定结论。
// 那是用户在网页上做认证时该发生的事，不该由一次只读查询触发。
import { NextResponse } from 'next/server';

import { resolveIdentity } from '@/lib/auth/identity';
import { failureResponse } from '@/lib/auth/http';
import { AUTH_STATUS, refreshRealnameStatus } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';
import { findUserById } from '@/lib/db/otp';

export async function GET(req: Request) {
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    return NextResponse.json(
      { ok: false, error_code: 'UNAUTHORIZED', message: '缺少或无效的凭据' },
      { status: 401 },
    );
  }

  if (identity.via === 'api_key') {
    return NextResponse.json({
      ok: true,
      auth_status: findUserById(getDb(), identity.uid)?.auth_status ?? AUTH_STATUS.none,
    });
  }

  const result = await refreshRealnameStatus(getDb(), { userId: identity.uid });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    ok: true,
    auth_status: result.authStatus,
    verification_status: result.verificationStatus,
    method: result.method,
    message: result.message,
  });
}
