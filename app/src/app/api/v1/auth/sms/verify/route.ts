// app/src/app/api/v1/auth/sms/verify/route.ts
// POST /api/v1/auth/sms/verify  {phone, code, agree_terms, agree_adult} → {ok, token, need_email}
// need_email=true 表示该账号还没验过邮箱，前端应接着走 /auth/email/send（spec §8 双验证）。
//
// 两个勾选位是**发登录态的前置条件**（协议 一.3、二.6 / 附一 #1、#2）：闸与落台账都在
// lib/auth/consent.ts 一处，见那里的抬头（为什么每次登录都要带、老用户怎么补勾）。
import { verifyPhoneCode } from '@/lib/auth';
import { recordRegistrationConsent, registrationConsentFailure } from '@/lib/auth/consent';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { extractClientIp } from '@/lib/auth/ip-quota';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  // 先判同意再验码：验码是有副作用的（标记已用、累加尝试次数），
  // 而"没勾选"这件事不该消耗掉用户手上那串码。
  const db = getDb();
  const consentFailure = registrationConsentFailure(db, body, null);
  if (consentFailure) return failureResponse(consentFailure);

  const result = verifyPhoneCode(db, {
    phone: stringField(body, 'phone'),
    code: stringField(body, 'code'),
  });
  if (!result.ok) return failureResponse(result);

  recordRegistrationConsent(db, result.userId, body, extractClientIp(req.headers));

  return apiJson({ ok: true, token: result.token, need_email: result.needEmail });
}
