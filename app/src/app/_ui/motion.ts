'use client';

import { useSyncExternalStore } from 'react';

/**
 * 动效基座。**全站动效时长 / 曲线 / 降级 / 触觉的唯一出口**。
 *
 * 立这个出口的由头与 `Mascot` 那条一样：靠各处记得写条件是记不住的。
 * 页面里不许再出现 `duration-[380ms]` 这种现场数字，也不许再出现第二处自己读
 * `matchMedia('(prefers-reduced-motion: reduce)')` 的代码——独立写 N 次就会忘 N 次。
 *
 * 【本文件的硬约束】**不 import gsap**。
 * 它要能在 node 环境（本仓库 vitest 的默认环境，没有 DOM）里被直接测，
 * 「降级到底降没降」这件事必须有测试钉着，而不是靠肉眼看动画。需要 gsap 的地方走 `@/hooks/gsap`。
 *
 * 【A 路（gsap）与 B 路（WAAPI）两套原语并存；同名冲突处双名分离（manager 2026-08-31 裁定）】
 *  - 时长：`MO`（A，配 `sec()` 喂 gsap）与 `MOTION`（B，毫秒，配 WAAPI/CSS）。
 *  - 缓动：`EASE`（A，缓动**函数**，gsap 的 `ease` 直接吃）与 `EASE_CSS`（B，**字符串**
 *    `cubic-bezier(...)`，WAAPI 的 `easing` / CSS 直接吃）。两类消费者要的类型真不相容，
 *    双名是诚实的类型分离，**不做运行时转换**。
 *  - 触觉：`haptic()` 统一过 `hapticEnabled()` 用户开关——关掉触觉的设置必须被尊重。
 *
 * 【减弱动效 SSR / 取不到 matchMedia 时默认 `true`（偏向不动）（manager 2026-08-31 裁定）】
 * 本产品用户是危机高压期的劳动者，前庭敏感者被首屏甩一下是真实生理伤害，
 * 而普通用户首帧少一次入场只是无感损失——取不准时偏向不伤人。动效本是 hydrate 后的增强层
 * （入场 stagger 等本就 hydrate 后触发），默认 true 不会让页面「像坏了」。
 *
 * 【CSS 侧的同名 token 在 `globals.css` 末尾「动效 v1」段】
 * 两边的数值由 `motion-tokens.test.ts` 对齐，改一边不改另一边直接报红。
 */

// ─────────────────────────────────────────────────────────────
// 时长
// ─────────────────────────────────────────────────────────────

/**
 * 时长（毫秒）。A 路（gsap 编排）用，与 `globals.css` 的 `--mo-*` 逐值相同。
 *
 * - `tap` 按压、勾选描边、tab 高亮
 * - `base` 默认：入场、状态色、边框
 * - `exit` 一切退场（= base × 0.67，用户已经决定离开了）
 * - `sheet` 抽屉升起（沿用现值）
 * - `seal` 落章，全站唯一 >300ms 的单次动效
 * - `track` 里程碑推进编排总长（编排内每一步仍 ≤250ms）
 */
export const MO = {
  tap: 120,
  base: 180,
  exit: 120,
  sheet: 250,
  seal: 420,
  track: 900,
} as const;

/** 时长档位（毫秒）。B 路（WAAPI / CSS 过渡）用，与 globals.css 的 `--mo-*` **逐值对应**。 */
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
  /** 多张卡入场的错开间隔 */
  stagger: 60,
} as const;

/** gsap 吃秒，CSS 吃毫秒。别在调用处现除 1000。 */
export function sec(ms: number): number {
  return ms / 1000;
}

// ─────────────────────────────────────────────────────────────
// 缓动
// ─────────────────────────────────────────────────────────────

/** 缓动控制点。与 `globals.css` 的 `--ease-*` 逐值相同（`lin` 对应 `linear`，不列控制点）。 */
export const EASE_BEZIER = {
  /** 入场 / 常规 */
  out: [0.2, 0, 0, 1],
  /** 退场 */
  in: [0.4, 0, 1, 1],
  /** 全站唯一带过冲，**只给落章**（复用落地页 `.anjuan-stamp` 那条曲线） */
  seal: [0.2, 1.6, 0.4, 1],
} as const;

/**
 * CSS `cubic-bezier(x1,y1,x2,y2)` 的 JS 同名实现。
 *
 * 不引 `CustomEase` 插件、也不拿 `power2.out` 近似顶替：近似顶替会让**同一个语义**
 * 在 CSS 侧和 JS 侧走两条不同的曲线，正是原则「同语义全站同曲线」要防的事。
 * Newton 迭代求 t，8 轮足够（误差 <1e-5，肉眼不可分）。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - p;
      if (Math.abs(dx) < 1e-5) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return sampleY(t < 0 ? 0 : t > 1 ? 1 : t);
  };
}

/** A 路：gsap 可直接吃的 ease **函数**，名字与 CSS 侧一一对应。 */
export const EASE = {
  out: cubicBezier(...EASE_BEZIER.out),
  in: cubicBezier(...EASE_BEZIER.in),
  seal: cubicBezier(...EASE_BEZIER.seal),
  /** 进度专用。**进度用 ease 会撒谎**——它让人以为快到了或者卡住了 */
  lin: (p: number) => p,
} as const;

/** B 路：WAAPI 的 `easing` 与 CSS 直接吃的 ease **字符串**。 */
export const EASE_CSS = {
  /** 入场/常规 */
  out: 'cubic-bezier(0.2, 0, 0, 1)',
  /** 退场 */
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  /** 只给进度：进度用 ease 会撒谎 */
  lin: 'linear',
} as const;

// ─────────────────────────────────────────────────────────────
// 降级（SSR / 无 matchMedia 时默认 true，偏向不动）
// ─────────────────────────────────────────────────────────────

export const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function reduceMql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(REDUCE_QUERY);
}

/**
 * **量不到时一律偏向「不动」**。
 *
 * SSR、以及任何拿不到 `matchMedia` 的环境，返回 `true`。
 * 反过来（默认 false ＝ 默认要动）在前庭敏感者身上的失败形态是「先甩他一下再改正」，
 * 而这个方向的错误恰恰听起来更像「功能正常」——取不准时偏向报警那一侧。
 */
export function prefersReducedMotion(): boolean {
  const m = reduceMql();
  return m ? m.matches : true;
}

function subscribeReduce(onChange: () => void): () => void {
  const m = reduceMql();
  if (!m) return () => {};
  // 用户会在会话中途改系统设置（尤其是「动画看着难受」才想起来去关的那种）
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
}

/**
 * 减弱动效开关。`useSyncExternalStore` 而不是 `useState + useEffect`：
 * 后者首帧必然是「没减弱」，等于每次进页面都先播一帧再改口。服务端快照恒为 true。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, prefersReducedMotion, () => true);
}

/**
 * 程序化滚动的 behavior。**每一处 `window.scrollTo` / `scrollIntoView` 都要过它**，
 * 不许再出现字面量 `behavior: 'smooth'`。
 *
 * A 路调用方传入自己已算好的 `reduce`（多半来自 `useReducedMotion()`）；
 * B 路无参调用，函数自读 `prefersReducedMotion()`。两条都收敛到这一个真源。
 */
export function scrollBehavior(reduce?: boolean, smooth = true): ScrollBehavior {
  const r = reduce ?? prefersReducedMotion();
  return r || !smooth ? 'auto' : 'smooth';
}

// ─────────────────────────────────────────────────────────────
// WAAPI（B 路）
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// 触觉（统一过 hapticEnabled 开关）
// ─────────────────────────────────────────────────────────────

/**
 * 触觉模式表。**不随减弱动效关闭**——那是另一条通道，
 * 关动画的人没说过不要震动，而慌乱时指尖确认比视觉确认可靠。
 */
export const HAPTIC = {
  /** 长按满 600ms：「到了，可以松手」 */
  longPress: 12,
  /** 勾选行动卡完成 */
  actionDone: 8,
  /** 整组 n/n 清空：一次小庆祝 */
  groupClear: [10, 40, 10],
  /** 里程碑落章，与视觉同帧 */
  seal: 12,
} as const;

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
 * 触觉统一出口。**故意不看 prefers-reduced-motion**（那是视觉通道的偏好），
 * 但**看用户自己的触觉开关 `hapticEnabled()`**——关掉触觉的设置必须被尊重，恐慌钮也不例外
 * （manager 2026-08-31 裁定）。
 *
 * `navigator.vibrate` **Android/Chrome 有、iOS Safari 无**，所以它一律只是可选增强：
 * **不许有任何信息只由触觉承载**。
 *
 * @returns 是否真的震了。调用点不该依赖它，只用于测试与调试。
 */
export function haptic(pattern: number | readonly number[]): boolean {
  // 用 `'vibrate' in navigator` 而不是 `typeof navigator.vibrate`：不支持的环境（iOS Safari）
  // 一半移动用户，能力判断走 `in` 就够，不去 get 那个属性（省一次没意义的读，也让守卫可测）。
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return false;
  if (!hapticEnabled()) return false;
  try {
    return navigator.vibrate(pattern as number | number[]);
  } catch {
    // vibrate 被用户手势策略拦下会抛（NotAllowedError）——那只是没震，不该炸页面
    return false;
  }
}
