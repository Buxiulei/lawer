'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, humanError } from '@/app/_ui/api';
import { ServerCopy } from '@/app/_ui/serverCopy';
import { Alert } from '@/components/shadcn/alert';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';

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
 *
 * 【删除请求的入口也在这张卡上】协议九.3 与附一第 9 项要求「你可以要求 NBDpsy 删除该转介
 * 信息」。此前它只有 MCP 工具与 REST 一条路——**不接自带 agent 的人在网页上一个按钮都点不到**
 *（2026-09-07 复审）。摆在这里而不是「我的数据」那张卡：要撤回哪一条得先看得见是哪一条，
 * 而转介台账只画在这里；这张卡在没有转介记录时整张不渲染，也就不会给没转介过的人
 * 平白摆一个「删除转介」的按钮。
 * 它仍然不让人**发起**转介——撤回一次已经发生的对外披露，与发起一次新的披露不是一件事。
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

/** 一条已经提出的删除请求（服务端 listReferralDeleteRequests 的形状）。 */
interface DeleteRequestRow {
  request_id: number;
  referral_id: number | null;
  /** true = 已经发给对方了。今天恒为 false（对方还没有这条接口） */
  delivered: boolean;
  requested_at: string;
}

interface ReferralsBody {
  referrals: ReferralRow[];
  consent: { shared: ConsentItem[]; not_shared: string[] };
  delete_requests: DeleteRequestRow[];
  /** 「已记下、还没送达、由人工转达」那句话的正本，服务端下发（REFERRAL_DELETE_PENDING_NOTE） */
  delete_note: string;
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
  /** 正在等用户确认要删的那一条转介 id */
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(() => {
    // 读不到（没登录、后端出错）就当没有记录：这张卡是附加信息，不该在设置页上报错。
    void apiFetch<ReferralsBody>('/referrals')
      .then(setBody)
      .catch(() => setBody(null));
  }, []);

  useEffect(load, [load]);

  const confirmDelete = () => {
    const id = pending;
    if (id === null) return;
    setBusy(true);
    void apiFetch<{ note: string }>(`/referrals/${id}/delete-request`, { method: 'POST', body: {} })
      .then((r) => {
        // 回包那句 note 原样念给用户听：**不要说成「已经删掉了」**，那是一句我们此刻
        // 还证明不了的话（同 referral_delete_request 工具说明里的那条禁令）。
        setSaid({ tone: 'ok', text: r.note });
        load();
      })
      .catch((err) => setSaid({ tone: 'bad', text: humanError(err) }))
      .finally(() => {
        setBusy(false);
        setPending(null);
      });
  };

  if (!body || body.referrals.length === 0) return null;

  const requestedFor = new Set(
    body.delete_requests.map((r) => r.referral_id).filter((id): id is number => id !== null),
  );

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
              {requestedFor.has(r.referral_id) ? (
                // 提过就不再给按钮，并如实说它停在哪一步。写「已删除」是不行的：
                // 东西在对方手上，我们此刻只做到了"记下并待人工转达"。
                <p className="mt-1 text-[13px] leading-6 text-ink-2">
                  已提出删除请求，尚未送达对方。
                </p>
              ) : (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setSaid(null);
                      setPending(r.referral_id);
                    }}
                  >
                    要求删除这条转介
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {said ? (
          <Alert tone={said.tone === 'bad' ? 'danger' : undefined} className="mt-3">
            <ServerCopy text={said.text} />
          </Alert>
        ) : null}

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

        <ConfirmDialog
          open={pending !== null}
          title="要求删除这条转介"
          // 后果那句话是服务端给的（REFERRAL_DELETE_PENDING_NOTE），页面不另写一份
          description={<ServerCopy text={body.delete_note} />}
          confirmLabel="确认提出删除请求"
          onConfirm={confirmDelete}
          onCancel={() => setPending(null)}
        />
      </CardContent>
    </Card>
  );
}
