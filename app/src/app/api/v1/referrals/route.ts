// app/src/app/api/v1/referrals/route.ts
// GET 本人名下的转介台账。设置页那张卡按它判「要不要显示自己」——
// 从没转介过的人不该在设置里看到一张空卡（设计稿 §14：入口只在有记录时显示状态）。
//
// 【不回数据包全文】payload_json 里有姓名与摘要。这条端点只答「转介过没有、到哪一步了」，
// 全文留在服务端。回全文的形态是：一份为站外机构准备的东西，在浏览器缓存里又躺了一遍。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { listUserReferrals, REFERRAL_CONSENT_ITEMS, REFERRAL_NOT_SHARED } from '@/lib/referral';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  return NextResponse.json({
    ok: true,
    referrals: listUserReferrals(getDb(), guard.identity.uid),
    // 同意文案随台账一起下发：网页与 agent 念的必须是同一份（正本在 lib/referral/consent）。
    consent: { shared: REFERRAL_CONSENT_ITEMS, not_shared: REFERRAL_NOT_SHARED },
  });
}
