'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/app/_ui/cn';
import { animate, animateAlways, EASE_CSS, haptic, MOTION } from '@/app/_ui/motion';
import { EyeIcon, EyeOffIcon } from './shellIcons';
import { HOLD_MS, useDiscreetToggle } from './useDiscreetToggle';

/** 进度环半径（在 44×44 的 viewBox 里）与它的周长。 */
const R = 20;
const CIRC = 2 * Math.PI * R;

/**
 * 拇指区的低调模式钮：有人走过来时一按就把屏幕糊上。
 *
 * **开关判定（单击开、按住 0.6 秒才关、键盘直切、已开单击给提示）全在 useDiscreetToggle 里**，
 * 与顶栏那个眼睛钮共用一份——这一层只在它前后叠加**表现**（进度环 / 触觉 / 按压缩放），
 * 不自己判开关。判定与表现分家是故意的：判定要能在 node 环境直接测，表现得有 DOM。
 *
 * 只在移动端出现：它要占的是拇指区，而拇指区正是底部 Tab 所在的那条；
 * PC 上侧栏左下角本来就常驻一个「低调模式」开关，再浮一个会压住右侧的案件档案面板。
 *
 * 【工单 B4：按压反馈从「缩一下」换成环形进度】
 * 外圈画一道进度环，600ms 走满，**linear**——进度用 ease 会撒谎。按下缩到 0.94 一次性 120ms。
 *
 * 【为什么进度环用 WAAPI（animateAlways）而不是 CSS】
 * globals.css 底部那条全局 `animation-duration: .01ms !important` 会把任何 CSS 动画压掉，
 * 而这道环**必须在减弱动效下照常走**：它是进度反馈不是装饰，没有位移、没有前庭刺激——
 * 去掉它用户就不知道还要按多久。WAAPI 不受那条 CSS 规则管辖。
 *
 * 【触觉】走统一的 `haptic()`（它自己看用户的触觉开关 hapticEnabled）。
 * **只挂在指针路径上**：键盘切换走 `pressProps.onKeyDown`，不触 haptic（manager 2026-08-31 裁定）。
 */
export function PanicButton() {
  const { discreet, holding, pressProps } = useDiscreetToggle();
  const [pressed, setPressed] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const ringAnim = useRef<Animation | null>(null);
  /** 表现层自持的计时器，与 hook 的判定计时器同时长（HOLD_MS）：只管画环 + 到点触觉。 */
  const holdTimer = useRef<number | null>(null);
  /** 表现层的「长按已满」镜像 hook 内部的 closed：满了那一下松手是「关完」不是「开」，别再震一次开的触觉。 */
  const holdDone = useRef(false);

  /** 撤掉表现：清计时、把环收回。判定的撤销由 pressProps 自己做，这里不碰。 */
  const stopVisual = useCallback(() => {
    setPressed(false);
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    const el = ring.current;
    const running = ringAnim.current;
    ringAnim.current = null;
    if (!el || !running) return;
    // 读一次当前位置再取消，否则环会从满格瞬移回去。收回也是进度反馈，走 animateAlways：减弱动效下照走。
    const at = getComputedStyle(el).strokeDashoffset;
    running.cancel();
    animateAlways(el, [{ strokeDashoffset: at }, { strokeDashoffset: `${CIRC}` }], {
      duration: MOTION.exit,
      easing: EASE_CSS.lin,
    });
  }, []);

  useEffect(() => stopVisual, [stopVisual]);

  const onPointerDown = () => {
    holdDone.current = false;
    setPressed(true);
    if (discreet) {
      // 按住关闭：画进度环 + 一个与 hook 同时长的计时器，到点给「可以松手」的触觉。
      // 真正的 setDiscreet(false) 由 hook 的计时器做，这条只管画与震。
      ringAnim.current = animateAlways(
        ring.current,
        [{ strokeDashoffset: `${CIRC}` }, { strokeDashoffset: '0' }],
        { duration: HOLD_MS, easing: EASE_CSS.lin, fill: 'forwards' },
      );
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        ringAnim.current = null; // 环已满，留着，别播回收
        holdDone.current = true;
        haptic(12); // 「到了，可以松手」。指尖先知道，眼睛后知道
      }, HOLD_MS);
    }
    pressProps.onPointerDown();
  };

  const onPointerUp = () => {
    const wasOpen = !discreet; // 松手前是关着的 ⇒ 这一下是开启
    const justClosed = holdDone.current; // 长按刚关完 ⇒ 松手不是开
    stopVisual();
    pressProps.onPointerUp();
    if (justClosed || !wasOpen) return;
    // **全站最重要的一次触觉**：慌乱时用户不看屏，指尖确认比视觉确认可靠。
    haptic(20);
    // 这一下过 animate()：装饰性确认，减弱动效时压成 0（按钮底色照样切）
    animate(btn.current, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], {
      duration: MOTION.tap,
      easing: EASE_CSS.out,
    });
  };

  const onPointerCancel = () => {
    stopVisual();
    pressProps.onPointerCancel();
  };

  const onPointerLeave = () => {
    stopVisual();
    pressProps.onPointerLeave();
  };

  return (
    <button
      ref={btn}
      type="button"
      aria-pressed={pressProps['aria-pressed']}
      aria-label={pressProps['aria-label']}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={pressProps.onContextMenu}
      onKeyDown={pressProps.onKeyDown}
      className={cn(
        'fixed right-3 z-50 flex size-11 touch-none items-center justify-center lg:hidden',
        'rounded-full border border-line shadow-soft select-none',
        // 按下缩一档。减弱动效时全局 CSS 把过渡时长压掉，只剩静止的按下态——
        // 「按住了」这条信息由 scale 的**终态**承载，不由过程承载。
        'mo-press',
        pressed ? 'scale-[0.94]' : 'scale-100',
        discreet ? 'bg-primary-wash text-primary-ink' : 'bg-surface text-ink-2',
        // 抬到底部固定层之上。--bottom-bar-h 由 StickyBottomBar 按实测高写入，
        // 没有操作条的页面它就是 Tab 那条的高——所以这里只有一档，不再猜页面有没有条
        'bottom-[calc(var(--bottom-bar-h)+8px)]',
      )}
    >
      {/* 进度环。**只在按住关闭时才画**——开启没有门槛，画一道空环反而像在等什么。
          「按住不放」这条信息在 aria-label 里另有一份，环不是唯一的判据。 */}
      <svg
        aria-hidden
        viewBox="0 0 44 44"
        className={cn(
          'pointer-events-none absolute inset-0 size-11 -rotate-90',
          holding ? 'opacity-100' : 'opacity-0',
        )}
      >
        <circle
          ref={ring}
          cx="22"
          cy="22"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC}
        />
      </svg>
      {discreet ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}
