'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BYO_GUIDE_HREF } from '@/app/_ui/byoAgent';
import { Button } from '@/components/shadcn/button';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Skeleton } from '@/components/shadcn/skeleton';
import { CodeBlock } from './CodeBlock';
import type { AgentKeySecret } from './useAgentKeySecret';

/**
 * 「你现在这把密钥」这一小节。接入卡与接入指南共用一份——两处各画各的形态是
 * 一处能看见明文、另一处还写着「只显示一次」。
 *
 * 【为什么「旧密钥不可查看」不是一句道歉】那把 key 签发的时候我们确实没留明文，
 * 今天也变不出来。这一屏能给的唯一真出路是**轮换**：名字与权限都不变，只换那串。
 * 所以三种态各自带着自己的按钮，没有一种是「知道了」。
 */
export function CurrentKey({
  secret,
  /** 没有 key 时是否给一条去生成的链接。接入指南自己第一步就是生成，不需要 */
  offerIssueLink = true,
}: {
  secret: AgentKeySecret;
  offerIssueLink?: boolean;
}) {
  const { state, rotate, rotating } = secret;
  const [confirming, setConfirming] = useState(false);

  if (state.kind === 'loading') return <Skeleton className="h-24 w-full" />;
  if (state.kind === 'signedOut') return null;

  if (state.kind === 'none') {
    return (
      <p className="text-[14px] leading-6 text-ink-2">
        还没有密钥。
        {offerIssueLink && (
          <>
            <Link
              href={BYO_GUIDE_HREF}
              className="mx-1 text-primary-ink underline underline-offset-4"
            >
              照指南生成一把
            </Link>
            ，下面这段配置就会自动填上它。
          </>
        )}
      </p>
    );
  }

  const rotateButton = (
    <Button size="sm" variant="secondary" disabled={rotating} onClick={() => setConfirming(true)}>
      {rotating ? '正在换…' : '轮换密钥'}
    </Button>
  );

  return (
    <div>
      <p className="text-[14px] leading-6 text-ink-2">
        当前这把：<span className="font-semibold text-ink">{state.name}</span>
      </p>

      {state.kind === 'ready' && (
        <div className="mt-2">
          <CodeBlock
            code={state.secret}
            wrap
            copyLabel="复制密钥"
            copiedMessage="密钥已复制"
          />
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            忘了随时回来看，不用重新生成。下面那段配置里已经替你填好了它。
          </p>
        </div>
      )}

      {state.kind === 'legacy' && (
        <p className="mt-1 text-[14px] leading-6 text-ink-2">
          这是一把旧密钥，看不到明文——它签发的时候我们还没留存，今天也变不出来。
          换一把新的就能看见了，名字和权限都不变。
        </p>
      )}

      {state.kind === 'error' && (
        <p className="mt-1 rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
          {state.message}
        </p>
      )}

      <div className="mt-2">{rotateButton}</div>

      <ConfirmDialog
        open={confirming}
        title="换一把新密钥"
        description={
          <>
            换完这一刻起，现在这串就用不了了——正在用「{state.name}」连着的助手会断开，
            要把新密钥重新配进去才能接着用。名字和权限都不变。
          </>
        }
        confirmLabel="确认轮换"
        tone="danger"
        onConfirm={() => {
          setConfirming(false);
          void rotate();
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
