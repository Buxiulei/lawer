'use client';

import type { RefObject } from 'react';

import { EASE, MO, sec, useReducedMotion } from '@/app/_ui/motion';
import { gsap, useGSAP } from './gsap';

export interface EnterStaggerOptions {
  /** 在 scope 内找谁。**必须过 scope**：本仓库同名组件会同时在屏，裸选择器跨组件命中 */
  selector: string;
  /** 位移起点（px）。只走 transform，不动 layout 属性 */
  y?: number;
  /** 每项间隔（毫秒） */
  each?: number;
  /** 谁先进。期限瓦片用 `end` ——最急那张最后到，视线落在它身上 */
  from?: 'start' | 'end';
  /** 单项时长（毫秒） */
  duration?: number;
  /** 等滚到视野里再播。首屏元素上 IntersectionObserver 会立刻命中，等于挂载即播 */
  inView?: boolean;
}

/**
 * 入场 stagger。驾驶舱三部件（A7）与期限瓦片（A6）共用。
 *
 * **失败形态刻意选在「不播」这一侧**：不预先把元素藏起来，
 * 而是等真要播的那一刻才由 `gsap.from` 把起点按下去。
 * 反过来（先 `set` 成透明、等观察器回调再放出来）一旦观察器没触发——
 * 元素被 `display:none` 的祖先包着、浏览器不支持、回调被异常打断——
 * 结果是**一片本该有内容的空白，而且不报错**。这是本仓库反复吃过的那类亏。
 *
 * 减弱动效下**整条不建**：终态本来就是 React 渲染出来的样子，什么都不做就是终态。
 */
export function useEnterStagger(
  scope: RefObject<HTMLElement | null>,
  opts: EnterStaggerOptions,
) {
  const reduce = useReducedMotion();
  const { selector, y = 10, each = 60, from = 'start', duration = MO.base, inView = false } = opts;

  useGSAP(
    (_context, contextSafe) => {
      if (reduce) return;
      const root = scope.current;
      if (!root) return;
      const items = gsap.utils.toArray<HTMLElement>(selector, root);
      if (items.length === 0) return;

      // 观察器回调在 useGSAP 执行**之后**才跑，不过 contextSafe 就不进 context、
      // 卸载时不会被 revert（gsap-react 的硬要求）
      const play = contextSafe!(() => {
        gsap.from(items, {
          y,
          autoAlpha: 0,
          duration: sec(duration),
          ease: EASE.out,
          stagger: { each: sec(each), from },
        });
      });

      if (!inView || typeof IntersectionObserver === 'undefined') {
        play();
        return;
      }

      const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        // 每次冷启动只播一次
        io.disconnect();
        play();
      });
      io.observe(root);
      return () => io.disconnect();
    },
    { dependencies: [reduce], scope },
  );
}
