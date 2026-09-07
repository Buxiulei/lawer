// app/src/app/api/v1/me/preferences/route.ts
// POST /api/v1/me/preferences  {overseas_models?, eval_optin?, consent?} → {ok, overseas_models, eval_optin}
//
// 设置页那两个开关（协议 五.3 / 五.5（2）；附一 #5、#6）。**只认网页登录态**：
// 「把我的对话交给境外接收方」这件事必须由用户本人在读过 /terms/overseas 之后点，
// 不能由他的 agent 代劳——那正是单独同意要防的情形。
//
// 【为什么开启境外要 consent:true 而不是"页面上点过就行"】页面上点过什么，服务端不知道。
// 闸只认两件事：这次请求带没带 consent:true（＝用户刚在说明页上确认过），
// 或者台账里此前有没有 overseas 那一行。两者都没有就拒——
// 少了这道闸的形态是：谁都可以直接 POST 一次把开关打开，而"我们向你说明过"这句话没有落点。
//
// 关闭永远不需要同意：撤回是用户的权利（协议五.9），不该有任何前置条件。
import { requireWebSession } from '@/lib/auth/guard';
import { badRequest, failureResponse, readJsonBody } from '@/lib/auth/http';
import { extractClientIp } from '@/lib/auth/ip-quota';
import { CONSENT_KINDS } from '@/lib/consent';
import { getDb } from '@/lib/db/client';
import { hasConsent, ipDigest, recordConsent } from '@/lib/db/consents';
import { getModelPreferences, setModelPreferences } from '@/lib/db/otp';
import { apiJson } from '@/lib/http/json';

/** 只认布尔真/假；没给（undefined）＝这一项不动 */
function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  return typeof v === 'boolean' ? v : undefined;
}

export async function POST(req: Request) {
  const db = getDb();
  const guard = requireWebSession(db, req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const uid = guard.identity.uid;
  const overseas = boolField(body, 'overseas_models');
  const evalOptin = boolField(body, 'eval_optin');
  if (overseas === undefined && evalOptin === undefined) {
    return badRequest('NO_FIELDS', 'overseas_models 与 eval_optin 至少要传一个');
  }

  if (overseas === true) {
    if (body.consent === true) {
      recordConsent(db, {
        userId: uid,
        kind: CONSENT_KINDS.overseas,
        ipDigest: ipDigest(extractClientIp(req.headers)),
      });
    } else if (!hasConsent(db, uid, CONSENT_KINDS.overseas)) {
      return failureResponse({
        ok: false,
        status: 400,
        errorCode: 'CONSENT_REQUIRED',
        // 自述三段式：缺什么 / 为什么缺 / 怎么办
        message:
          '还差一次单独同意：开启境外模型意味着你的对话与档案摘要会交给境外接收方处理。' +
          '为什么要单独问：接收方在境外，你向它行使权利的方式与境内不同，所以要先把' +
          '「它是谁、处理什么、怎么处理、你怎么行使权利」讲清楚，再由你自己决定。' +
          '怎么办：在设置页读完那页说明后点「同意并开启」（请求里带 consent:true）。' +
          '不开启也不缺功能：关着时全部走境内模型。',
      });
    }
  }

  setModelPreferences(db, uid, {
    ...(overseas === undefined ? {} : { overseasModels: overseas }),
    ...(evalOptin === undefined ? {} : { evalOptin }),
  });

  const now = getModelPreferences(db, uid);
  return apiJson({ ok: true, overseas_models: now.overseasModels, eval_optin: now.evalOptin });
}
