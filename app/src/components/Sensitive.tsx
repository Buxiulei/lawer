'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';

const REVEAL_MS = 3000;

/**
 * 低调模式下打码的内容容器：金额、公司名、案件标题。
 * 点按临时显示 3 秒，之后自动恢复打码。
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
      aria-label={revealed ? '内容已临时显示' : '内容已打码，点按临时显示 3 秒'}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reveal();
        }
      }}
      className={cn(
        'cursor-pointer select-none',
        !revealed && 'discreet-blur',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
