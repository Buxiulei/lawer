'use client';

import { useEffect } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useDiscreet } from './discreet';
import { DISCREET_ON_HINT, HOLD_HINT } from './revealHint';

/** 按住多久才算「我要看清这块」。短于它的都是滚动时手指划过。 */
const PRESS_MS = 150;
/** 按住期间允许的位移，超过就当成滚动，不揭。 */
const MOVE_SLOP = 10;
/** 松手后还能再看多久。留这段延迟是因为松手那一瞬眼睛还在读。 */
const RECOVER_MS = 1500;

const HINT_KEY = 'lawer.veilHint';
const HINT_TEXT = DISCREET_ON_HINT;

/**
 * 低调模式二档的手势层：正文由 CSS 整体糊着（见 globals.css 的 [data-veil]），
 * 这里只负责在按住某一块时给它加上 data-veil-open，松手 1.5 秒后摘掉。
 *
 * 用一个文档级委托而不是每个块各自挂 state：正文块成百上千，
 * 每块一个 React 组件既多出成百上千个订阅者，滚动时还要跟着 re-render。
 * 委托的另一半好处是纯属性也能用——文书详情页那种服务端组件
 * 直接写个 data-veil 就进层了，不必为了打码把整棵树转成客户端组件。
 *
 * 挂一次即可（AppShell 里），只在低调模式开着时才装监听。
 */
export function DiscreetVeil() {
  const { discreet } = useDiscreet();
  const toast = useToast();

  // 二档第一次开启时说一句怎么用，否则一片糊看着像页面坏了
  useEffect(() => {
    if (!discreet) return;
    try {
      if (localStorage.getItem(HINT_KEY) === '1') return;
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // 隐私模式下读写都可能抛：那就每次开启都提示一遍，比不提示好
    }
    // 提示本身不带案件信息，低调文案与明文同一句
    toast(HINT_TEXT, 'neutral', HINT_TEXT);
  }, [discreet, toast]);

  useEffect(() => {
    if (!discreet) return;

    let pressTimer: number | null = null;
    let recoverTimer: number | null = null;
    let pending: { el: HTMLElement; x: number; y: number } | null = null;
    let open: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    /** 按住看清之后紧跟的那次 click 不该再当点击用（证据表格的行会开详情） */
    let swallowClick = false;

    const blockOf = (node: EventTarget | null) =>
      node instanceof Element
        ? node.closest<HTMLElement>('[data-veil]')
        : null;

    const clearPress = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      pending = null;
    };

    const cancelRecover = () => {
      if (recoverTimer !== null) {
        clearTimeout(recoverTimer);
        recoverTimer = null;
      }
    };

    const close = () => {
      if (!open) return;
      delete open.dataset.veilOpen;
      open = null;
    };

    const onDown = (e: PointerEvent) => {
      swallowClick = false;
      if (e.button !== 0) return;
      const el = blockOf(e.target);
      if (!el) {
        // 按到别处：当场糊回去，不等那 1.5 秒
        cancelRecover();
        close();
        return;
      }
      if (el === open) {
        cancelRecover();
        return;
      }
      clearPress();
      pending = { el, x: e.clientX, y: e.clientY };
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        if (!pending) return;
        const next = pending.el;
        pending = null;
        cancelRecover();
        close();
        next.dataset.veilOpen = '';
        open = next;
        swallowClick = true;
      }, PRESS_MS);
    };

    const onMove = (e: PointerEvent) => {
      if (!pending) return;
      if (
        Math.abs(e.clientX - pending.x) > MOVE_SLOP ||
        Math.abs(e.clientY - pending.y) > MOVE_SLOP
      ) {
        clearPress();
      }
    };

    const onUp = () => {
      clearPress();
      if (open) {
        cancelRecover();
        recoverTimer = window.setTimeout(() => {
          recoverTimer = null;
          close();
        }, RECOVER_MS);
      }
    };

    // 触屏滚动起来后不再发 pointermove，只发 pointercancel；
    // 这里再补一道，惯性滚动期间手指还压着也不会揭。
    const onScroll = () => clearPress();

    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    // 输入框拿到焦点时所在块自动清晰——正在打的字必须看得见
    const onFocusIn = (e: FocusEvent) => {
      const el = blockOf(e.target);
      if (el === focused) return;
      if (focused) delete focused.dataset.veilFocus;
      focused = el;
      if (el) el.dataset.veilFocus = '';
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!focused) return;
      const next = e.relatedTarget;
      if (next instanceof Node && focused.contains(next)) return;
      delete focused.dataset.veilFocus;
      focused = null;
    };

    // 长按弹出的系统菜单会把糊着的原文一字不差地摆出来
    const onContextMenu = (e: MouseEvent) => {
      if (blockOf(e.target)) e.preventDefault();
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('click', onClick, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('contextmenu', onContextMenu, true);

    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      clearPress();
      cancelRecover();
      close();
      if (focused) {
        delete focused.dataset.veilFocus;
        focused = null;
      }
    };
  }, [discreet]);

  // 常驻提示：糊层的手势只能写在糊块**外面**——filter 对整棵子树一视同仁，
  // 贴在糊块上的角标会跟着糊掉，糊掉的角标等于没有（见 revealHint 的长注释）。
  // **闸只有低调模式这一道**：这一句是「两种块各自写明手势」的糊层那一半，
  // 低调模式开着它就得在。按「用过一次就退场」之类的条件收起来，等于对用过的人
  // 又回到 F-206 报的原样（同屏两种糊块、零视觉区分），而那是台账上没有的裁决。
  if (!discreet) return null;
  return (
    <p
      role="note"
      data-reveal-hint="hold"
      className="fixed bottom-[calc(var(--bottom-bar-h)+8px)] left-3 z-40 rounded-full border border-line bg-surface/95 px-2.5 py-1 text-[12px] leading-5 text-ink-2 shadow-soft backdrop-blur-sm lg:bottom-4"
    >
      {HOLD_HINT}
    </p>
  );
}
