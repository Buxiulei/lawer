// app/src/app/api/v1/realname/init/route.ts
// POST /api/v1/realname/init  {real_name, id_card}，需 Authorization: Bearer <jwt>
//   → {ok, certify_url, certify_id, verification_id}
// certify_url 是阿里云 H5 活体认证页，前端跳过去让用户在手机上刷脸；完成后阿里云跳回
// CLOUDAUTH_RETURN_URL_BASE/realname/callback，前端再打 GET /api/v1/realname/status 取结论。
//
// 只认网页登录态：实名是把真实身份绑到账号上的一次性动作，不该由用户的 agent 代劳。
//
// body 里还要带 consent:true —— 收证件号前那一次单独同意（协议 五.2（1）/ 附一 #4），
// 判定与文案在 lib/auth/consent.ts realnameConsentFailure 一处。
import { REALNAME_CONSENT_FIELD, realnameConsentFailure } from '@/lib/auth/consent';
import { requireWebSession } from '@/lib/auth/guard';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { extractClientIp } from '@/lib/auth/ip-quota';
import { startRealname } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request) {
  const db = getDb();
  const guard = requireWebSession(db, req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  // 同意在**读证件号之前**判：问必须在收之前（见 realnameConsentFailure 抬头）。
  const consentFailure = realnameConsentFailure(
    db,
    guard.identity.uid,
    body[REALNAME_CONSENT_FIELD] === true,
    extractClientIp(req.headers),
  );
  if (consentFailure) return failureResponse(consentFailure);

  const result = await startRealname(db, {
    userId: guard.identity.uid,
    realName: stringField(body, 'real_name'),
    idCard: stringField(body, 'id_card'),
  });
  if (!result.ok) return failureResponse(result);

  return apiJson({
    ok: true,
    certify_url: result.certifyUrl,
    certify_id: result.certifyId,
    verification_id: result.verificationId,
  });
}
