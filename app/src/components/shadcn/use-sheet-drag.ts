'use client';

import { useEffect } from 'react';
import { animate, EASE_CSS, haptic, MOTION } from '@/app/_ui/motion';

/** 起拖门槛：低于它的下移都当成犹豫或滚动，让给内部滚动 */
const START_SLOP = 8;
/** 拖过抽屉高度的这个比例就松手即关 */
const CLOSE_RATIO = 0.25;
/** 或者甩得足够快（px/ms）。慢慢拖到 20% 不关，快速一甩就关——两条判据是或的关系 */
const CLOSE_VELOCITY = 0.5;
/** 背景随拖动变亮的幅度：拖到底时 overlay 只剩四成 */
const OVERLAY_FADE = 0.6;
/** 侧推档不做下拉关闭，这是移动端底部档专属手势 */
const SIDE_SHEET_QUERY = '(min-width: 768px)';

/**
 * 抽屉下拉关闭（工单 B2）。只在 <md 的**底部档**启用。
 *
 * 【为什么手势永远不是唯一路径】
 * `SheetClose` 与 Esc 始终在。手势是给拇指的捷径，不是可达性的替代品——
 * 触屏之外（键盘、读屏、桌面鼠标）根本没有这条路。
 *
 * 【为什么关闭走 Radix 而不是自己 animate 完再卸载】
 * 自己播完退场再改 open，就有两套时序：Radix 的 Presence 还会再播一遍它自己的
 * `sheet-down`，两条必打架。这里的做法是**先清掉跟手写的 inline transform，
 * 再让 Radix 走它的状态机**——CSS 动画的优先级高于 inline style，
 * 所以清不清在视觉上一样，清掉只是不留脏属性。
 *
 * 【读写分离】
 * 高度与 overlay 只在 pointerdown 读一次；此后每帧只写，且写进 rAF 合批。
 * **绝不在 pointermove 里 getBoundingClientRect**——读写交错就是 layout thrash。
 *
 * 【为什么收元素而不是 ref】
 * 抽屉关着的时候 Radix 的 Presence 根本不渲染 Content，`ref.current` 是 null；
 * 而 ref 的赋值不会触发重渲染，**依赖 ref 的 effect 只会在首次挂载时跑那一次、
 * 那一次又恰好是 null**——监听器于是永远装不上，而且**一行报错都没有**。
 * 所以调用方用 `useState` 存回调 ref 拿到的节点，节点一到就重跑这个 effect。
 */
export function useSheetDrag(el: HTMLElement | null, requestClose: () => void): void {
  useEffect(() => {
    if (!el || typeof window === 'undefined') return;

    const side = window.matchMedia(SIDE_SHEET_QUERY);

    let pointer: number | null = null;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let dy = 0;
    /** 已经越过 START_SLOP、真的在拖了（在此之前不吞事件，点击照常） */
    let dragging = false;
    /** 越过关闭阈值的那一下只震一次 */
    let crossed = false;
    /** pointerdown 时读一次，之后只写 */
    let height = 1;
    let overlay: HTMLElement | null = null;
    let frame = 0;

    const write = () => {
      frame = 0;
      el.style.transform = `translateY(${dy}px)`;
      if (overlay) overlay.style.opacity = String(1 - (dy / height) * OVERLAY_FADE);
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };

    const reset = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      delete el.dataset.sheetDragging;
      el.style.willChange = '';
      pointer = null;
      dragging = false;
      crossed = false;
    };

    const onDown = (e: PointerEvent) => {
      if (pointer !== null || e.button !== 0 || side.matches) return;
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;

      const header = el.querySelector<HTMLElement>('[data-slot="sheet-header"]');
      const body = el.querySelector<HTMLElement>('[data-slot="sheet-body"]');
      // 抓手区（整条 header）随时可拖；正文区只有已经滚到顶时才让给拖拽，
      // 否则用户想往回滚内容却把抽屉拽下去了。
      const fromHeader = Boolean(header?.contains(target));
      const fromBodyTop = Boolean(body?.contains(target)) && (body?.scrollTop ?? 1) === 0;
      if (!fromHeader && !fromBodyTop) return;

      height = Math.max(1, el.getBoundingClientRect().height);
      overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');
      pointer = e.pointerId;
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      dy = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const raw = e.clientY - startY;

      if (!dragging) {
        // 只认向下。向上划是要滚内容，不是要关抽屉。
        if (raw < START_SLOP) return;
        dragging = true;
        el.dataset.sheetDragging = '';
        // will-change 只在拖拽期间挂，松手就摘——常驻会把图层永久钉住
        el.style.willChange = 'transform';
        el.setPointerCapture?.(e.pointerId);
      }

      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;

      dy = Math.max(0, raw);
      if (!crossed && dy > height * CLOSE_RATIO) {
        crossed = true;
        // 告诉手指「松手就关了」。这一下不受 prefers-reduced-motion 影响（另一个通道）
        haptic(10);
      }
      schedule();
    };

    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const wasDragging = dragging;
      const travelled = dy;
      const shouldClose =
        wasDragging && (travelled > height * CLOSE_RATIO || velocity > CLOSE_VELOCITY);
      reset();
      if (!wasDragging) return;

      // 先把跟手写的 inline 样式清掉，再决定去留：
      // 关 → 交给 Radix 播它自己的 sheet-down；留 → 从当前位置弹回 0。
      el.style.transform = '';
      const overlayFrom = overlay ? 1 - (travelled / height) * OVERLAY_FADE : 1;
      if (overlay) overlay.style.opacity = '';

      if (shouldClose) {
        requestClose();
        return;
      }
      // 弹回。减弱动效时 animate() 把时长压成 0——手指在拖的那一段照走（直接操作），
      // 只有这一下「自己跑回去」的位移会被降掉。
      animate(
        el,
        [{ transform: `translateY(${travelled}px)` }, { transform: 'translateY(0px)' }],
        { duration: MOTION.layer, easing: EASE_CSS.out },
      );
      animate(overlay, [{ opacity: overlayFrom }, { opacity: 1 }], {
        duration: MOTION.layer,
        easing: EASE_CSS.out,
      });
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const travelled = dy;
      reset();
      el.style.transform = '';
      if (overlay) overlay.style.opacity = '';
      if (travelled > 0) {
        animate(
          el,
          [{ transform: `translateY(${travelled}px)` }, { transform: 'translateY(0px)' }],
          { duration: MOTION.layer, easing: EASE_CSS.out },
        );
      }
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', onCancel);

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', onCancel);
      if (frame !== 0) cancelAnimationFrame(frame);
      // 卸载时不留任何 inline 残留：抽屉是复用的，下次升起要从干净状态开始
      el.style.transform = '';
      el.style.willChange = '';
      delete el.dataset.sheetDragging;
      if (overlay) overlay.style.opacity = '';
    };
  }, [el, requestClose]);
}
