// app/src/app/api/v1/consents/route.ts
// POST /api/v1/consents  {kind} → {ok, kind, first_time}
//
// 页面上那些「我同意」按钮的落点（协议 附一 #3、#4）。**只认网页登录态**：
// 同意必须是用户本人在页面上、读过说明之后做的动作——由 api key 代劳的"同意"，
// 在法律上不是同意，在产品上是我们替他点了头。
//
// 【为什么只收白名单里那两类】其余几类各有各的采集点，且都必须与"说明"同屏发生：
//   terms / adult   —— 登录页那两个勾选框，随验码请求一起来（lib/auth/consent.ts）
//   realname        —— 实名页发起认证时随请求一起来（同上）
//   overseas        —— 设置页那个开关，与 users.overseas_models 同一次请求（me/preferences）
// 把它们也开在这条通用路由上，等于给"没看过说明也能同意"开一扇门。
import { requireWebSession } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { extractClientIp } from '@/lib/auth/ip-quota';
import { CONSENT_KINDS, type ConsentKind } from '@/lib/consent';
import { getDb } from '@/lib/db/client';
import { ipDigest, recordConsent } from '@/lib/db/consents';
import { apiJson } from '@/lib/http/json';

/** 这条路由收得下的同意类别（其余的各有采集点，见文件头） */
const GRANTABLE: readonly ConsentKind[] = [CONSENT_KINDS.realnameAdopt, CONSENT_KINDS.emotion];

export async function POST(req: Request) {
  const db = getDb();
  const guard = requireWebSession(db, req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const kind = stringField(body, 'kind') as ConsentKind;
  if (!GRANTABLE.includes(kind)) {
    return badRequest(
      'INVALID_KIND',
      `kind 只能是 ${GRANTABLE.join(' / ')}。` +
        '协议、年龄、实名、境外模型这四类同意各有自己的采集点，' +
        '要与对应的那段说明同屏给出，不从这条通用路由收。',
    );
  }

  const { created } = recordConsent(db, {
    userId: guard.identity.uid,
    kind,
    ipDigest: ipDigest(extractClientIp(req.headers)),
  });
  // first_time=false = 此前就同意过。**不当错误**：用户在两个标签页各点一次，
  // 第二次回一个 4xx 会让人以为刚才那次没生效。
  return apiJson({ ok: true, kind, first_time: created });
}
