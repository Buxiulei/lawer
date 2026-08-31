'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useToast } from '@/components/ui/Toast';
import { EyeIcon, EyeOffIcon } from './shellIcons';

/** 关闭要按住多久。开启没有门槛，关闭才有——两个方向的代价不对称是故意的。 */
const HOLD_MS = 600;

/**
 * 拇指区的低调模式钮：有人走过来时一按就把屏幕糊上。
 *
 * 开和关不对称：**单击开**（慌的时候没有第二次机会），**按住 0.6 秒才关**
 * （在地铁上误蹭一下就把金额亮出来，比多按半秒糟糕得多）。已开启时单击只给一句提示。
 * 键盘上回车直接开关——长按防的是误触，键盘不存在这个问题。
 *
 * 只在移动端出现：它要占的是拇指区，而拇指区正是底部 Tab 所在的那条；
 * PC 上侧栏左下角本来就常驻一个「低调模式」开关，再浮一个会压住右侧的案件档案面板。
 * 顶栏那个开关照旧留着，这里只是把它挪进够得着的地方。
 */
export function PanicButton() {
  const { discreet, setDiscreet } = useDiscreet();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  /** 长按已经生效：随后的 pointerup 不要再当成单击处理 */
  const closed = useRef(false);

  const stopHold = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setHolding(false);
  }, []);

  useEffect(() => stopHold, [stopHold]);

  const onDown = () => {
    closed.current = false;
    if (!discreet) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      closed.current = true;
      stopHold();
      setDiscreet(false);
    }, HOLD_MS);
  };

  const onUp = () => {
    stopHold();
    if (closed.current) return;
    if (discreet) toast('长按可以关闭', 'neutral', '长按可以关闭');
    else setDiscreet(true);
  };

  return (
    <button
      type="button"
      aria-pressed={discreet}
      aria-label={discreet ? '关闭低调模式（按住不放）' : '开启低调模式'}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={stopHold}
      onPointerLeave={stopHold}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        setDiscreet(!discreet);
      }}
      className={cn(
        'fixed right-3 z-50 flex size-11 touch-none items-center justify-center lg:hidden',
        'rounded-full border border-line shadow-soft select-none',
        // 按住期间缩一下当进度反馈；减弱动效时全局 CSS 会把过渡时长压掉，只剩静止的按下态
        'transition-transform ease-out',
        holding ? 'scale-90 duration-[600ms]' : 'scale-100 duration-150',
        discreet ? 'bg-primary-wash text-primary-ink' : 'bg-surface text-ink-2',
        // 抬到底部固定层之上。--bottom-bar-h 由 StickyBottomBar 按实测高写入，
        // 没有操作条的页面它就是 Tab 那条的高——所以这里只有一档，不再猜页面有没有条
        'bottom-[calc(var(--bottom-bar-h)+8px)]',
      )}
    >
      {discreet ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}
