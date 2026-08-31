'use client';

import { cn } from '@/app/_ui/cn';
import { EyeIcon, EyeOffIcon } from './shellIcons';
import { useDiscreetToggle } from './useDiscreetToggle';

/**
 * 拇指区的低调模式钮：有人走过来时一按就把屏幕糊上。
 *
 * 开关判定（单击开、按住 0.6 秒才关）在 useDiscreetToggle 里，与顶栏那个眼睛钮共用一份。
 *
 * 只在移动端出现：它要占的是拇指区，而拇指区正是底部 Tab 所在的那条；
 * PC 上侧栏左下角本来就常驻一个「低调模式」开关，再浮一个会压住右侧的案件档案面板。
 * 顶栏那个开关照旧留着，这里只是把它挪进够得着的地方。
 */
export function PanicButton() {
  const { discreet, holding, pressProps } = useDiscreetToggle();

  return (
    <button
      type="button"
      {...pressProps}
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
