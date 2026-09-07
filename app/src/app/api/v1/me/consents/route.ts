// app/src/app/api/v1/me/consents/route.ts
// GET  读本人的单独同意清单与它们此刻的状态
// POST 撤回其中一项（协议五.2(4)、五.9「撤回同意」，附一第 7 项）
//
// 【为什么撤回是 POST 一个动作，而不是 DELETE 一行】撤回不删记录：谁在什么时候撤了哪一项
// 要留得下来（同分享链接的撤销）。DELETE 会让调用方以为那条同意记录也没了，
// 而它恰恰是我们日后要拿出来的凭据。
//
// 【只认网页登录态】撤回同意会当场关掉功能（情绪记录停写、模型路由改道）。
// 让一把 api key 也能做，等于任何一个接进来的助手都能替用户关掉他自己开的东西。
import { requireWebSession } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';
import { listConsentStates, revokeConsent } from '@/lib/lifecycle/consents';

export async function GET(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  return apiJson({ ok: true, consents: listConsentStates(getDb(), guard.identity.uid) });
}

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) {
    return apiJson(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }
  const outcome = revokeConsent(getDb(), {
    userId: guard.identity.uid,
    kind: body.kind,
    note: body.note,
  });
  if (!outcome.ok) {
    return apiJson(
      { ok: false, error_code: outcome.errorCode, message: outcome.message },
      { status: outcome.status },
    );
  }
  return apiJson(outcome);
}
