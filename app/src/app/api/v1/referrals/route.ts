// app/src/app/api/v1/referrals/route.ts
// GET 本人名下的转介台账。设置页那张卡按它判「要不要显示自己」——
// 从没转介过的人不该在设置里看到一张空卡（设计稿 §14：入口只在有记录时显示状态）。
//
// 【不回数据包全文】payload_json 里有姓名与摘要。这条端点只答「转介过没有、到哪一步了」，
// 全文留在服务端。回全文的形态是：一份为站外机构准备的东西，在浏览器缓存里又躺了一遍。

import { requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';
import {
  REFERRAL_DELETE_PENDING_NOTE,
  listReferralDeleteRequests,
} from '@/lib/lifecycle/referral-delete';
import { listUserReferrals, REFERRAL_CONSENT_ITEMS, REFERRAL_NOT_SHARED } from '@/lib/referral';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  return apiJson({
    ok: true,
    referrals: listUserReferrals(getDb(), guard.identity.uid),
    // 同意文案随台账一起下发：网页与 agent 念的必须是同一份（正本在 lib/referral/consent）。
    consent: { shared: REFERRAL_CONSENT_ITEMS, not_shared: REFERRAL_NOT_SHARED },
    // 【删除请求也随台账下发】附一第 9 项的入口在网页上必须点得到（协议九.3）。
    // 只回"提没提过 + 送没送达"，不回理由原文：那是用户写给我们的一句话，
    // 每一次打开设置页都把它再取一遍没有必要。
    delete_requests: listReferralDeleteRequests(getDb(), guard.identity.uid),
    // 「今天还发不出去、由人工转达」这句话的正本在服务端（同 consent 那份）。
    // 页面自己写一版的形态是：接口通道开出来那天，服务端改了，页面还在念旧的。
    delete_note: REFERRAL_DELETE_PENDING_NOTE,
  });
}
