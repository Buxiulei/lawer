'use client';

import { useSyncExternalStore } from 'react';

/**
 * 动效基座（工单 A1，B 路全部工单的前置）。
 *
 * 【这里为什么必须存在】
 * globals.css 底部那条 `* { animation-duration: .01ms !important }` 是**只管 CSS 的钝刀**，
 * 管不到 JS：`window.scrollTo({behavior:'smooth'})`、`Element.animate()` 都不受它影响。
 * 而程序化平滑滚动正是前庭敏感者最难受的一类运动。所以 JS 侧的减弱动效判断
 * **只有这一个真源**，页面里不许再各写一遍 matchMedia。
 *
 * 【降级不是「缩短」，是「跳到终态」】
 * `animate()` 在减弱动效下把时长压成 0 而不是 0.01ms——同一条代码路径、同一套 fill 语义，
 * 元素直接落在终态上。装饰性的动效（落章、庆祝、探头）**整条不建**，
 * 调用点自己用 `prefersReducedMotion()` 提前 return，不要建一条 0ms 的动画凑数。
 *
 * 【降级 ≠ 全关，三处点名例外】
 *  1. **进度反馈**（长按关低调的按压环）：走 `animateAlways()`。它不是装饰——
 *     去掉它用户就不知道还要按多久，而且没有位移、没有前庭刺激。
 *  2. **跟手位移**（抽屉拖拽）：手指在拖，那是直接操作不是动画，照走；
 *     只有「松手弹回」那一下过 `animate()`，减弱时降为 0。
 *  3. **触觉**：`haptic()` **不看** prefers-reduced-motion——那是另一个通道，
 *     减少视觉运动的人没有理由同时失去指尖确认。它只看用户自己的触觉开关。
 */

/** 时长档位（毫秒）。与 globals.css 的 `--mo-*` **逐值对应**，改一处要改两处。 */
export const MOTION = {
  /** 按压、勾选描边、tab 高亮 */
  tap: 120,
  /** 默认：入场、状态色、边框 */
  base: 180,
  /** 一切退场（= base × 0.67） */
  exit: 120,
  /** 同级切换：四个 Tab 交叉淡入、流内三态 crossfade */
  route: 160,
  /** 进出一层：下钻入场 / 抽屉落下 / 拖拽弹回 */
  layer: 200,
  /** 抽屉升起 */
  sheet: 250,
  /**
   * 多张卡入场的错开间隔。
   *
   * 落章（420ms）与里程碑推进编排（900ms）**故意还没在这里**：
   * 它们由 A 路 A3/A4 工单和第一个使用者一起加进来。
   * 没人用的档位是在骗后来人「这里有个规范」。
   */
  stagger: 60,
} as const;

/** 缓动。与 globals.css 的 `--ease-*` 逐值对应。 */
export const EASE = {
  /** 入场/常规 */
  out: 'cubic-bezier(0.2, 0, 0, 1)',
  /** 退场 */
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  /** 只给进度：进度用 ease 会撒谎。全站唯一允许过冲的 --ease-seal 随 A4 落章基元一起进来 */
  lin: 'linear',
} as const;

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(REDUCE_QUERY);
}

/**
 * 命令式读一次。服务端渲染与拿不到 matchMedia 的环境一律回 false——
 * **偏向"照常播"而不是"照常关"**：这里读错的代价是多一次 180ms 的淡入，
 * 而首屏把所有入场都掐掉会让页面看起来是坏的。
 */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => {};
  // 用户会在会话中途改系统设置（尤其是 iOS 的「减弱动态效果」在控制中心里），
  // 只在挂载时读一次会让改完之后的这一页仍然在动。
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** 组件里用它。服务端快照恒为 false，客户端挂载后按真实媒体查询走。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
}

/**
 * 程序化滚动的 behavior。**每一处 `window.scrollTo` / `scrollIntoView` 都要过它**，
 * 不许再出现字面量 `behavior: 'smooth'`。
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

type Target = Element | null | undefined;

function canAnimate(el: Target): el is Element {
  return Boolean(el) && typeof (el as Element).animate === 'function';
}

/**
 * WAAPI 薄封装。**减弱动效时时长与延迟一律压成 0**（跳到终态，不是播 0.01ms）。
 *
 * 用 WAAPI 而不是 CSS 类的判据见 DESIGN 动效篇 §3.2：起止两端能写成 class/data 属性、
 * 中间没有要 JS 算的数值 ⇒ 走 CSS；否则走这里。
 */
export function animate(
  el: Target,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!canAnimate(el)) return null;
  const reduced = prefersReducedMotion();
  return el.animate(
    keyframes,
    reduced ? { ...options, duration: 0, delay: 0 } : options,
  );
}

/**
 * **点名例外**：不随 prefers-reduced-motion 降级的动效只能走这一支，
 * 且调用点必须写清楚为什么。目前全站只有一处：PanicButton 的按压环进度。
 *
 * 用 WAAPI 而不是 CSS 也正因为这条——globals.css 那条全局 `!important`
 * 会把任何 CSS 动画的时长压掉，进度环用 CSS 写就不可能"照常走"。
 */
export function animateAlways(
  el: Target,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!canAnimate(el)) return null;
  return el.animate(keyframes, options);
}

/* ── 触觉 ─────────────────────────────────────────────────────
   `navigator.vibrate` **Android/Chrome 有、iOS Safari 没有**，
   所以它一律是可选增强：**不许有任何信息只由触觉承载**。 */

const HAPTIC_KEY = 'lawer.haptics';

/** 默认开。读不到 localStorage（隐私模式）时也按开算。 */
export function hapticEnabled(): boolean {
  try {
    return localStorage.getItem(HAPTIC_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setHapticEnabled(on: boolean): void {
  try {
    localStorage.setItem(HAPTIC_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式下写不进去：本次会话内照用户点的走，下次回到默认开
  }
}

/**
 * 触觉统一出口。**故意不看 prefers-reduced-motion**——那是视觉通道的偏好，
 * 而慌乱时用户根本不看屏，指尖确认比视觉确认可靠（低调模式开启的那一下尤其）。
 *
 * @returns 是否真的震了。调用点不该依赖它，只用于测试与调试。
 */
export function haptic(pattern: number | number[]): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return false;
  }
  if (!hapticEnabled()) return false;
  return navigator.vibrate(pattern);
}
