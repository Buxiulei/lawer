'use client';

import { useCallback, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { Card } from '@/components/shadcn/card';
import { COMPLAINT_ACK_WORKDAYS, COMPLAINT_REPLY_WORKDAYS } from '@/lib/complaints-policy';

import { WooNav } from '../_components/WooNav';

interface ComplaintRow {
  complaint_id: number;
  receipt_no: string;
  kind: string;
  body: string;
  contact: string;
  created_at: string;
  user_id: number | null;
}

/**
 * 受理台账（**只读**）。
 *
 * 【为什么这一页没有任何按钮】受理与答复走站外（协议第十二条留的那个邮箱）。
 * 摆一个「标记已受理」的按钮而后端没有对应的状态与审计的形态是：
 * 点下去页面变了、库里什么也没变，而主理人从此以为这条已经处理过。
 * 状态流转要做时，连同 complaints 表的 status 列、写接口与审计一起加。
 *
 * 【404 从哪来】接口对非白名单回的是空体 404（同 /woo/codes 的口径）。
 * 这里就地 notFound()，用户看到的是全站那张 404 卡——与随便敲一个不存在的地址完全一样。
 *
 * 【为什么把联系方式整串画出来】这一页存在的理由就是让人能照着它去答复。
 * 打码的形态是：主理人看着一串 138****1234 又得回库里查一次，
 * 而那一步没有任何权限差别——只是多绕一圈。这一页的闸在接口那一侧。
 */
export function AdminComplaintsView() {
  const [rows, setRows] = useState<ComplaintRow[] | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ complaints: ComplaintRow[] }>('/admin/complaints');
      setRows(res.complaints);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      setError(humanError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // notFound() 必须在渲染期抛，不能在 effect 里调——放在这里，全站 404 边界接住。
  if (gone) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <WooNav />
      <h1 className="text-[20px] font-semibold text-ink">投诉与权利请求</h1>
      <p className="mt-2 text-[14px] leading-7 text-ink-2">
        协议第十二条对外承诺：<span className="num">{COMPLAINT_ACK_WORKDAYS}</span>{' '}
        个工作日内确认受理并给出编号，<span className="num">{COMPLAINT_REPLY_WORKDAYS}</span>{' '}
        个工作日内答复处理结果。本页只读，答复走站外邮箱。
      </p>

      {error && (
        <p className="mt-4 rounded-[10px] bg-danger-wash px-3 py-2.5 text-[14px] leading-6 text-danger-ink">
          {error}
        </p>
      )}

      {rows !== null && rows.length === 0 && (
        <p className="mt-4 text-[14px] leading-6 text-ink-2">还没有人提过。</p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {(rows ?? []).map((row) => (
          <Card key={row.complaint_id} className="p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="num text-[15px] font-semibold text-ink">{row.receipt_no}</span>
              <span className="rounded-[6px] bg-surface-2 px-2 py-0.5 text-[13px] text-ink-2">
                {row.kind}
              </span>
              <span className="num text-[13px] text-ink-2">{row.created_at}</span>
              <span className="num text-[13px] text-ink-2">
                {row.user_id === null ? '账号已注销' : `uid ${row.user_id}`}
              </span>
            </div>
            <p className="mt-2 text-[14px] leading-6 text-ink-2">
              联系方式：<span className="break-all text-ink">{row.contact}</span>
            </p>
            <p className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-ink">{row.body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
