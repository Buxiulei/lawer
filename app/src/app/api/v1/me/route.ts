// app/src/app/api/v1/me/route.ts
// GET 本人身份摘要。给「我的」页用——那一行昵称/手机号此前读的是 _mock/demo 的 demoUser。
//
// 【手机号在服务端掩码后才出】前端截等于完整号在响应里躺过一次：浏览器缓存、
// 代理日志、devtools 里全都留痕。这一页的隐私红线是「连存在性都不承认」（见 lib/cases 抬头），
// 手机号更不该为了省一次实现而多走一程。
//
// 【为什么没有 nickname】users 表里根本没有这个字段（见 migrate.ts），
// 全站也没有任何地方让用户起过名。**不编一个默认值顶上**——返回一个
// 「土八鼠用户」之类的假名，页面就会看起来正常，而那正是 P0-2 的病灶形态。
import { termsLive } from '@/lib/auth/consent';
import { requireIdentity } from '@/lib/auth/guard';
import { maskPhone } from '@/lib/auth/phone';
import { getMembership } from '@/lib/billing/fulfillment';
import { decryptField } from '@/lib/crypto';
import { getDb } from '@/lib/db/client';
import { consentedKinds } from '@/lib/db/consents';
import { getModelPreferences } from '@/lib/db/otp';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const db = getDb();
  const row = db
    .prepare('SELECT phone_enc, email, auth_status FROM users WHERE id = ?')
    .get(guard.identity.uid) as
    | { phone_enc: string | null; email: string | null; auth_status: string }
    | undefined;
  if (!row) {
    return apiJson(
      { ok: false, error_code: 'USER_NOT_FOUND', message: '用户不存在' },
      { status: 404 },
    );
  }

  // 未绑手机的账号确实存在（生产上就有），这时给 null 而不是空串——
  // 「没有」和「有但是空的」在前端是两种渲染，不该在这里被抹平成同一个。
  let phoneMasked: string | null = null;
  if (row.phone_enc) {
    try {
      phoneMasked = maskPhone(decryptField(row.phone_enc));
    } catch {
      phoneMasked = null; // 解不开就当没有，绝不回落明文
    }
  }

  const membership = getMembership(db, guard.identity.uid);
  const prefs = getModelPreferences(db, guard.identity.uid);

  return apiJson({
    ok: true,
    phone_masked: phoneMasked,
    email: row.email ?? null,
    auth_status: row.auth_status,
    // 设置页要一次性知道「哪几类同意过、两个开关是开是关」。
    // 分成几条接口各查一次的形态是：页面上开关的位置与它旁边那句「你在 X 时同意过」
    // 来自两次请求，中间任何一次失败都让这一格显示成"没同意"，而用户明明同意过。
    consents: consentedKinds(db, guard.identity.uid),
    preferences: { overseas_models: prefs.overseasModels, eval_optin: prefs.evalOptin },
    // 协议生效了没有（协议生效旗，见 lib/auth/consent.termsLive）。设置页那张境外卡据它决定是摆开关还是摆
    // 「暂未开放」。**跟着这一次取数回来，不另开一条端点**：开关的位置与"这一项开不开放"
    // 必须来自同一份数据，分两次问的形态是其中一次失败，页面画出一个可点的开关，
    // 而点下去服务端拒绝——页面显示的与实际发生的相反。
    terms_live: termsLive(),
    // 无有效会员时给 null，不给「无」这类占位串：前端按「查不到就不显示套餐徽标」处理。
    membership: membership.plan ? { plan: membership.plan, expires_at: membership.expiresAt } : null,
  });
}
