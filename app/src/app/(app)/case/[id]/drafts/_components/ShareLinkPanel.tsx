'use client';

import { useState } from 'react';
import {
  SHARE_TTL_DAYS,
  mockShareLinks,
  shareUrlOf,
  type ShareLink,
} from '@/app/_mock/docs-drafts';
import { formatDate, formatDateTime } from '@/app/_ui/format';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { useToast } from '@/components/ui/Toast';

type LinkState = '有效' | '已撤销' | '已过期';

function stateOf(link: ShareLink, now: number): LinkState {
  if (link.revokedAt) return '已撤销';
  if (new Date(link.expiresAt).getTime() < now) return '已过期';
  return '有效';
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/**
 * 只读分享链接：默认 7 天过期、可撤销（spec §10）。
 * 生成前必须过一次二次确认——链接一旦发出去，谁拿到谁能看。
 */
export function ShareLinkPanel({
  open,
  onClose,
  draftId,
  draftTitle,
}: {
  open: boolean;
  onClose: () => void;
  draftId: string;
  draftTitle: string;
}) {
  const toast = useToast();
  const [links, setLinks] = useState<ShareLink[]>(() =>
    mockShareLinks.filter((l) => l.draftId === draftId),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const now = Date.now();

  const generate = () => {
    const created = new Date();
    const expires = new Date(created.getTime() + SHARE_TTL_DAYS * 86_400_000);
    const link: ShareLink = {
      id: `sl_${created.getTime()}`,
      draftId,
      token: randomToken(),
      scope: '单文件下载',
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString(),
      revokedAt: null,
    };
    setLinks((prev) => [link, ...prev]);
    setConfirmOpen(false);
    toast(`链接已生成，${formatDate(link.expiresAt)} 自动失效`, 'success', '有一条新的更新');
  };

  const revoke = (id: string) => {
    setLinks((prev) =>
      prev.map((l) => (l.id === id ? { ...l, revokedAt: new Date().toISOString() } : l)),
    );
    toast('链接已撤销，旧链接立刻打不开了', 'neutral', '有一条新的更新');
  };

  const copy = (token: string) => {
    navigator.clipboard
      .writeText(shareUrlOf(token))
      .then(() => toast('链接已复制', 'success', '已复制'))
      .catch(() => toast('复制没成功，长按选中链接手动复制', 'neutral', '操作未完成'));
  };

  return (
    <>
      <AppSheet
        open={open}
        onClose={onClose}
        title="只读分享链接"
        footer={
          <Button className="w-full" onClick={() => setConfirmOpen(true)}>
            生成新的分享链接
          </Button>
        }
      >
        <p className="text-[15px] leading-7 text-ink-2">
          链接只能看这一份文书，看的人改不了、也进不了你的其他材料。默认 {SHARE_TTL_DAYS}{' '}
          天后自动失效，你可以随时撤销。
        </p>

        {links.length === 0 ? (
          <p className="mt-4 rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[15px] text-ink-2">
            还没有生成过链接
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {links.map((link) => {
              const state = stateOf(link, now);
              const alive = state === '有效';
              return (
                <li key={link.id}>
                  <Card className="p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={alive ? 'success' : 'neutral'}>{state}</Badge>
                    <span className="num text-[13px] text-ink-2">
                      {alive
                        ? `${formatDate(link.expiresAt)} 失效`
                        : link.revokedAt
                          ? `${formatDate(link.revokedAt)} 已撤销`
                          : `${formatDate(link.expiresAt)} 已过期`}
                    </span>
                  </div>

                  <p className="num mt-2 break-all text-[14px] leading-6 text-ink">
                    {shareUrlOf(link.token)}
                  </p>
                  <p className="num mt-1 text-[13px] text-ink-2">
                    生成于 {formatDateTime(link.createdAt)}
                  </p>

                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="secondary" disabled={!alive} onClick={() => copy(link.token)}>
                      复制链接
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!alive} onClick={() => revoke(link.id)}>
                      撤销
                    </Button>
                  </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </AppSheet>

      <ConfirmDialog
        open={confirmOpen}
        title="生成只读分享链接"
        description={
          <>
            任何拿到链接的人都可查看此文书（{draftTitle}）的全文，不需要登录、不需要验证身份。
            链接 {SHARE_TTL_DAYS} 天后自动失效，你也可以随时撤销。只发给你确实想给的人。
          </>
        }
        confirmLabel="确认生成分享链接"
        tone="danger"
        onConfirm={generate}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
