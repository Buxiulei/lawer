/**
 * 动效基座。**全站动效时长 / 曲线 / 降级 / 触觉的唯一出口**。
 *
 * 立这个出口的由头与 `Mascot` 那条一样：靠各处记得写条件是记不住的。
 * 页面里不许再出现 `duration-[380ms]` 这种现场数字（同批 3「`text-[NNpx]` 硬编码归零」），
 * 也不许再出现第二处自己读 `matchMedia('(prefers-reduced-motion: reduce)')` 的代码——
 * 独立写 N 次就会忘 N 次，那是默认形态不是疏忽。
 *
 * 【本文件的硬约束】**不 import gsap**。
 * 它要能在 node 环境（本仓库 vitest 的默认环境，没有 DOM）里被直接测，
 * 「降级到底降没降」这件事必须有测试钉着，而不是靠肉眼看动画。
 * 需要 gsap 的地方走 `@/hooks/gsap`。
 *
 * 【CSS 侧的同名 token 在 `globals.css` 末尾「动效 v1」段】
 * 两边的数值由 `src/app/__tests__/motion-tokens.test.ts` 对齐，改一边不改另一边直接报红。
 */

import { useSyncExternalStore } from 'react';

/**
 * 时长（毫秒）。与 `globals.css` 的 `--mo-*` 逐值相同。
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

/** gsap 吃秒，CSS 吃毫秒。别在调用处现除 1000。 */
export function sec(ms: number): number {
  return ms / 1000;
}

/** 缓动。与 `globals.css` 的 `--ease-*` 逐值相同（`lin` 对应 `linear`，不列控制点）。 */
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

/** gsap 可直接吃的 ease 函数，名字与 CSS 侧一一对应 */
export const EASE = {
  out: cubicBezier(...EASE_BEZIER.out),
  in: cubicBezier(...EASE_BEZIER.in),
  seal: cubicBezier(...EASE_BEZIER.seal),
  /** 进度专用。**进度用 ease 会撒谎**——它让人以为快到了或者卡住了 */
  lin: (p: number) => p,
} as const;

// ─────────────────────────────────────────────────────────────
// 降级
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
 * 后者首帧必然是「没减弱」，等于每次进页面都先播一帧再改口。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, prefersReducedMotion, () => true);
}

/**
 * 程序化滚动的 behavior。
 *
 * 立这个函数是因为 `globals.css` 底部那条 `* { animation-duration: .01ms }` 兜底
 * **管不到 JS**：`window.scrollTo({behavior:'smooth'})` 在减弱动效下照跑，
 * 而整屏平滑滚动正是前庭敏感者最难受的一类运动。凡是程序化滚动一律过这里。
 */
export function scrollBehavior(reduce: boolean, smooth = true): ScrollBehavior {
  return reduce || !smooth ? 'auto' : 'smooth';
}

// ─────────────────────────────────────────────────────────────
// 触觉
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

/**
 * 统一出口。`navigator.vibrate` **Android/Chrome 有、iOS Safari 无**，
 * 所以它一律只是可选增强：**不许有任何信息只由触觉承载**。
 */
export function haptic(pattern: number | readonly number[]): boolean {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return false;
  try {
    return navigator.vibrate(pattern as number | number[]);
  } catch {
    return false;
  }
}
