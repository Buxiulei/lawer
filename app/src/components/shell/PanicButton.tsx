'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { animate, animateAlways, EASE, haptic, MOTION } from '@/app/_ui/motion';
import { useToast } from '@/components/ui/Toast';
import { EyeIcon, EyeOffIcon } from './shellIcons';

/** 关闭要按住多久。开启没有门槛，关闭才有——两个方向的代价不对称是故意的。 */
const HOLD_MS = 600;

/** 进度环半径（在 44×44 的 viewBox 里）与它的周长。 */
const R = 20;
const CIRC = 2 * Math.PI * R;

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
 *
 * 【工单 B4：按压反馈从「缩一下」换成环形进度】
 * 原来用 `scale-90 duration-600` 表达「按住了」，但它**不告诉用户还差多久**。
 * 现在外圈画一道进度环，600ms 走满，**linear**——进度用 ease 会撒谎。
 * 按下缩到 0.94 仍然保留，但改成一次性的 120ms，不再跟着 600ms 走。
 *
 * 【为什么进度环用 WAAPI 而不是 CSS】
 * globals.css 底部那条全局 `animation-duration: .01ms !important` 会把任何 CSS 动画
 * 的时长压掉。而这道环**必须在减弱动效下照常走**：它是进度反馈不是装饰，
 * 而且没有位移、没有前庭刺激——去掉它用户就不知道还要按多久。
 * WAAPI 不受那条 CSS 规则管辖，所以它是这里唯一能表达「点名例外」的写法。
 */
export function PanicButton({ raised }: { raised: boolean }) {
  const { discreet, setDiscreet } = useDiscreet();
  const toast = useToast();
  const [pressed, setPressed] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const ringAnim = useRef<Animation | null>(null);
  /** 长按已经生效：随后的 pointerup 不要再当成单击处理 */
  const closed = useRef(false);

  const stopHold = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setPressed(false);
    setHolding(false);

    const el = ring.current;
    const running = ringAnim.current;
    ringAnim.current = null;
    if (!el || !running) return;
    // 读一次当前位置再取消，否则环会从满格瞬移回去。
    // 收回同样是进度反馈的一部分，走 animateAlways：减弱动效下照走。
    const at = getComputedStyle(el).strokeDashoffset;
    running.cancel();
    animateAlways(el, [{ strokeDashoffset: at }, { strokeDashoffset: `${CIRC}` }], {
      duration: MOTION.exit,
      easing: EASE.lin,
    });
  }, []);

  useEffect(() => stopHold, [stopHold]);

  const onDown = () => {
    closed.current = false;
    setPressed(true);
    if (!discreet) return;
    setHolding(true);
    ringAnim.current = animateAlways(
      ring.current,
      [{ strokeDashoffset: `${CIRC}` }, { strokeDashoffset: '0' }],
      { duration: HOLD_MS, easing: EASE.lin, fill: 'forwards' },
    );
    timer.current = window.setTimeout(() => {
      closed.current = true;
      // 环已经走满，直接摘掉，不要再播一遍收回
      ringAnim.current?.cancel();
      ringAnim.current = null;
      timer.current = null;
      setPressed(false);
      setHolding(false);
      // 「到了，可以松手」。指尖先知道，眼睛后知道
      haptic(12);
      setDiscreet(false);
    }, HOLD_MS);
  };

  const onUp = () => {
    stopHold();
    if (closed.current) return;
    if (discreet) {
      toast('长按可以关闭', 'neutral', '长按可以关闭');
      return;
    }
    // **全站最重要的一次触觉**：慌乱时用户不会看屏，指尖确认比视觉确认可靠。
    // 糊层本身刻意不做过渡（见 globals.css 工单 B5 的注释），给出确认的就是这里。
    haptic(20);
    // 这一下过 animate()：它是装饰性的确认，减弱动效时压成 0（按钮底色照样切）
    animate(btn.current, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], {
      duration: MOTION.tap,
      easing: EASE.out,
    });
    setDiscreet(true);
  };

  return (
    <button
      ref={btn}
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
        // 按下缩一档。减弱动效时全局 CSS 把过渡时长压掉，只剩静止的按下态——
        // 「按住了」这条信息由 scale 的**终态**承载，不由过程承载。
        'mo-press',
        pressed ? 'scale-[0.94]' : 'scale-100',
        discreet ? 'bg-primary-wash text-primary-ink' : 'bg-surface text-ink-2',
        // 底部有 sticky 操作条的页面（输入区 / 下一步条）把钮抬到它上面，别叠在主按钮上
        raised
          ? 'bottom-[calc(56px+env(safe-area-inset-bottom)+76px)]'
          : 'bottom-[calc(56px+env(safe-area-inset-bottom)+8px)]',
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
