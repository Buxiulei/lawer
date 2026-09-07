// app/src/lib/lifecycle/referral-delete.ts
// 转介删除请求（协议 v0.2 九.3：「转介一经发出即到达 NBDpsy；你可以要求 NBDpsy 删除该转介
// 信息」，附一第 9 项）。
//
// 【今天只到「本地记下」为止，而且要说出来】NBDpsy 内部接口的契约到 v1.4 为止只有两条：
// identity/v1/status 与 leads/v1/referral（见 lib/nbdpsy/client.ts 抬头与 BOARD 2026-09-06
// 两条记录）。**没有删除/撤回那一条**。所以这里不去调一个不存在的地址，也不给它编一个：
// 落一条 status='recorded' 的请求，并在回包里明写「已记下、还没发给对方、要人工转达」。
//
// 【为什么状态是 recorded 而不是 unsupported】对方开出通道的那天，要能一次把积压的请求
// 全捞出来发过去。写成 unsupported 的形态是：这些行看起来已经"处理完了"，
// 新通道上线后没有任何一条会被重发，而用户以为自己早就提过了。
//
// 【为什么请求要比转介活得久】referral_delete_requests.referral_id 是 ON DELETE SET NULL：
// 案件被硬删时 referrals 随案消失，而「这个人要求过对方删除」是我们对外的承诺记录，
// 跟着消失就等于我们再也证明不了他提过。
import type { Database } from 'better-sqlite3';

import type { DomainFailure, Result } from '@/lib/cases';
import * as lifecycle from '@/lib/db/lifecycle';
import * as referralStore from '@/lib/db/referrals';
import { nowSql, toSql } from '@/lib/db/time';

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 已记下、还没转达出去。对方通道就绪时按这个状态捞行重发。 */
export const REFERRAL_DELETE_RECORDED = 'recorded';

/** 对方还没有这条接口时，回包里那句话。只有一份，回包与清单读同一句。 */
export const REFERRAL_DELETE_PENDING_NOTE =
  '这条删除请求已经记在我们这边，但**还没有自动发给 NBDpsy**：' +
  '两边的内部接口契约（到 v1.4 为止）只有实名互认与投递转介两条，没有删除/撤回那一条。' +
  '我们会人工把它转达过去；你也可以直接通过「设置 → 帮助与投诉」催办，' +
  '我们会在 15 个工作日内答复处理结果（协议第十二条第 1 款）。' +
  '接口通道开出来之后，这条请求会被自动补发，不需要你再提一次。';

export interface ReferralDeleteRequested {
  request_id: number;
  referral_id: number;
  status: string;
  /** true = 已经发给对方了。今天恒为 false，理由见 note */
  delivered: boolean;
  requested_at: string;
  /** true = 之前就提过，这一次没有再记一条（幂等重放） */
  already_requested: boolean;
  note: string;
}

export interface RequestReferralDeleteInput {
  db: Database;
  userId: number;
  referralId: number;
  reason?: unknown;
  now?: Date;
}

/**
 * 对某一条转介提出删除请求。**幂等**：同一条转介再提一次照样成功，
 * already_requested=true，首次提出的时刻不变。
 *
 * 归属按「连存在性都不承认」办：不是自己的转介与不存在的转介回同一句话。
 */
export function requestReferralDelete(
  input: RequestReferralDeleteInput,
): Result<ReferralDeleteRequested> {
  const { db, userId, referralId } = input;
  if (!Number.isInteger(referralId) || referralId <= 0) {
    return fail(404, 'REFERRAL_NOT_FOUND', '转介记录不存在');
  }
  const referral = referralStore.findReferralById(db, referralId);
  if (!referral || referral.user_id !== userId) {
    return fail(404, 'REFERRAL_NOT_FOUND', '转介记录不存在');
  }

  const existing = lifecycle.findReferralDeleteRequest(db, referralId);
  if (existing) {
    return {
      ok: true,
      request_id: existing.id,
      referral_id: referralId,
      status: existing.status,
      delivered: existing.status === 'sent',
      requested_at: existing.requested_at,
      already_requested: true,
      note:
        '这条转介之前就已经提过删除请求了，本次没有再记一条（首次提出的时刻不变）。' +
        (existing.status === 'sent' ? '' : REFERRAL_DELETE_PENDING_NOTE),
    };
  }

  const now = input.now ? toSql(input.now) : nowSql();
  const id = lifecycle.insertReferralDeleteRequest(db, {
    referralId,
    userId,
    // 对方那条线索的号一起记下：人工转达时要报给对方，事后也要能对上账。
    // 转介还没发出去（external_ref 为空）时如实记 null，不编一个。
    externalRef: referral.external_ref,
    reason:
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 500)
        : null,
    status: REFERRAL_DELETE_RECORDED,
    now,
  });

  return {
    ok: true,
    request_id: id,
    referral_id: referralId,
    status: REFERRAL_DELETE_RECORDED,
    delivered: false,
    requested_at: now,
    already_requested: false,
    note: REFERRAL_DELETE_PENDING_NOTE,
  };
}

export interface ReferralDeleteRequestView {
  request_id: number;
  referral_id: number | null;
  status: string;
  delivered: boolean;
  requested_at: string;
  updated_at: string;
  last_error: string | null;
}

/** 本人提过的全部删除请求（设置页那张卡与 agent 的「我提过没有」都读它）。 */
export function listReferralDeleteRequests(
  db: Database,
  userId: number,
): ReferralDeleteRequestView[] {
  return lifecycle.listReferralDeleteRequests(db, userId).map((r) => ({
    request_id: r.id,
    referral_id: r.referral_id,
    status: r.status,
    delivered: r.status === 'sent',
    requested_at: r.requested_at,
    updated_at: r.updated_at,
    last_error: r.last_error,
  }));
}
