'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { TAP_HINT } from '@/app/_ui/revealHint';

const REVEAL_MS = 3000;

/**
 * 低调模式下打码的内容容器：金额、公司名、案件标题。
 * 点按临时显示 3 秒，之后自动恢复打码。
 *
 * 【为什么糊打在内层】站内另有一套整块糊层（`[data-veil]`，按住才揭开），
 * 两套外观一样、手势不同，用户分不清该点还是该按（见 _ui/revealHint 的长注释）。
 * 这里挂一枚「点一下看清」的角标当区分——而 `filter` 对整棵子树一视同仁，
 * 角标只要落在被糊的那个元素里就会跟着糊掉。所以糊下沉到内层 span，
 * 外层只剩手势与角标，角标才是清晰的。**别把 discreet-blur 挪回外层。**
 */
export function Sensitive({
  children,
  className,
  as: Tag = 'span',
}: {
  children: ReactNode;
  className?: string;
  as?: 'span' | 'div';
}) {
  const { discreet } = useDiscreet();
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!discreet) setRevealed(false);
  }, [discreet]);

  if (!discreet) {
    return <Tag className={className}>{children}</Tag>;
  }

  const reveal = () => {
    setRevealed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRevealed(false), REVEAL_MS);
  };

  return (
    <Tag
      role="button"
      tabIndex={0}
      aria-label={revealed ? '内容已临时显示' : `内容已打码，${TAP_HINT}（显示 3 秒）`}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reveal();
        }
      }}
      className={cn('cursor-pointer select-none', className)}
    >
      <span className={cn(!revealed && 'discreet-blur')}>{children}</span>
      {!revealed && (
        <span
          data-reveal-hint="tap"
          className="ml-1 inline-block whitespace-nowrap rounded-full border border-line px-1 align-[0.05em] text-[11px] leading-[1.5] font-normal text-ink-2"
        >
          {TAP_HINT}
        </span>
      )}
    </Tag>
  );
}
