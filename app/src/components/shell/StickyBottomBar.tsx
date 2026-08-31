'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { trackBottomBar } from './bottomBar';

/**
 * 贴在底部 Tab 之上的 sticky 操作条：首诊的「下一步」条、问它的输入区。
 *
 * 位置（`--tab-bar-h` 之上、z-30）与**把自己的实测高写进 `--bottom-bar-h`** 都在这里做，
 * 调用方只管给自己的皮肤类。悬浮低调钮和低调提示条都读那个变量定位，
 * 所以「底部到底占了多高」全站只有这一个答案。
 *
 * 用 layout effect 而不是普通 effect：变量要在首帧之前落定，
 * 晚一帧就会看见低调钮先压在按钮上再弹开。
 */
export function StickyBottomBar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return trackBottomBar(el, document.documentElement);
  }, []);

  return (
    <div ref={ref} className={cn('sticky bottom-[var(--tab-bar-h)] z-30 lg:bottom-0', className)}>
      {children}
    </div>
  );
}
