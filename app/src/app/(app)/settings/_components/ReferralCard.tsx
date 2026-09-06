'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/app/_ui/api';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';

/**
 * 「转介到 NBDpsy」（设计稿 §14）。
 *
 * 【这张卡不是入口，是状态】设置页不发起转介——转介发生在对话里（用户自己的 agent 或
 * 站内 agent 逐项念完同意文案、用户点头之后）。**没有记录时整张卡不渲染**：
 * 给从没转介过的人摆一张「你还没转介过」的卡，等于在设置页里放了一句劝他去做心理咨询的话。
 *
 * 【为什么把同意文案也画出来】它是给已经转介过的人回头核对用的——「我当时到底同意了什么」
 * 这个问题，答案不该只存在于当时那段对话里。文案正本在 lib/referral/consent，
 * 随台账一起从服务端下发，网页不另写一份。
 */

interface ConsentItem {
  field: string;
  label: string;
}

interface ReferralRow {
  referral_id: number;
  case_id: number;
  status: string;
  external_ref: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

interface ReferralsBody {
  referrals: ReferralRow[];
  consent: { shared: ConsentItem[]; not_shared: string[] };
}

/** 状态 → 给人看的一句话。**未知状态原样显示**，不吞成「处理中」：吞掉就再也查不出来了。 */
export function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return '待发送';
    case 'sent':
      return '已送达';
    case 'accepted':
      return '对方已接收';
    case 'declined':
      return '对方未接收';
    case 'failed':
      return '发送失败';
    default:
      return status;
  }
}

/**
 * 只有「发送失败」是要用户知道的坏消息；待发送不是错误，别画成红的
 * （DESIGN.md 色彩纪律：danger 只给风险与不可逆结论）。
 */
export function statusTone(status: string): BadgeTone {
  if (status === 'failed') return 'danger';
  if (status === 'sent' || status === 'accepted') return 'success';
  return 'neutral';
}

export function ReferralCard() {
  const [body, setBody] = useState<ReferralsBody | null>(null);

  useEffect(() => {
    // 读不到（没登录、后端出错）就当没有记录：这张卡是附加信息，不该在设置页上报错。
    void apiFetch<ReferralsBody>('/referrals')
      .then(setBody)
      .catch(() => setBody(null));
  }, []);

  if (!body || body.referrals.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>转介到 NBDpsy</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {body.referrals.map((r) => (
            <li key={r.referral_id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                <span className="text-[13px] text-ink-2">{r.created_at.slice(0, 16)}</span>
              </div>
              {r.external_ref ? (
                <p className="mt-1 text-[13px] leading-6 text-ink-2">
                  对方线索号 {r.external_ref}
                </p>
              ) : null}
              {r.last_error ? (
                <p className="mt-1 text-[13px] leading-6 text-ink-2">{r.last_error}</p>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded-[10px] border border-dashed border-line p-4">
          <p className="text-[14px] leading-6 text-ink">转介时发过去的是这些：</p>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-6 text-ink-2">
            {body.consent.shared.map((i) => (
              <li key={i.field}>{i.label}</li>
            ))}
          </ul>
          <p className="mt-3 text-[14px] leading-6 text-ink">不会发过去的：</p>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-6 text-ink-2">
            {body.consent.not_shared.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
