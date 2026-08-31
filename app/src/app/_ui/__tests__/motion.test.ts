/**
 * 动效基座的守卫。
 *
 * 这一组盯的全是**失败时画面看起来完全正常**的东西：
 * 减弱动效没降级、CSS 与 JS 的 token 各走各的、`vibrate` 在 iOS 上抛异常。
 * 没有一条会报错，全靠肉眼在真机上撞见——所以由测试钉着。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EASE,
  EASE_BEZIER,
  HAPTIC,
  MO,
  REDUCE_QUERY,
  cubicBezier,
  haptic,
  prefersReducedMotion,
  scrollBehavior,
  sec,
} from '../motion';

/** 造一个只认 `(prefers-reduced-motion: reduce)` 的 window，记下被问到的查询串 */
function fakeWindow(matches: boolean) {
  const asked: string[] = [];
  const listeners: Array<() => void> = [];
  (globalThis as { window?: unknown }).window = {
    matchMedia: (q: string) => {
      asked.push(q);
      return {
        // 拿字面量比，不拿 REDUCE_QUERY——假 window 也得像真浏览器那样只认这一条
        matches: q === '(prefers-reduced-motion: reduce)' ? matches : false,
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => {},
      };
    },
  };
  return { asked, listeners };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { navigator?: unknown }).navigator;
  vi.restoreAllMocks();
});

describe('减弱动效：读数', () => {
  /**
   * 查询串**写字面量，不写 `REDUCE_QUERY`**。
   * 拿常量去比常量是自己对自己，把常量改成 `no-preference` 两边一起变，测试照绿——
   * 那是「你以为验的是 X、实际验的是 Y」的标准形态。
   */
  it('问的是 (prefers-reduced-motion: reduce)，不是别的', () => {
    expect(REDUCE_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('系统说要减弱时返回 true，并且只问了这一条', () => {
    const { asked } = fakeWindow(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(asked).toEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('系统说不用减弱时返回 false', () => {
    fakeWindow(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  /**
   * **取不准时偏向「不动」。** 反过来（默认要动）的失败形态是先甩用户一下再改口，
   * 而那个方向的错误听起来更像「功能正常」——所以默认必须是 true。
   */
  it('拿不到 matchMedia（SSR / 老浏览器）时按「要减弱」办', () => {
    expect(prefersReducedMotion()).toBe(true);
    (globalThis as { window?: unknown }).window = {};
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('程序化滚动的降级', () => {
  it('减弱动效下一律 auto——CSS 那条全局兜底管不到 JS 滚动', () => {
    expect(scrollBehavior(true)).toBe('auto');
    expect(scrollBehavior(true, true)).toBe('auto');
  });

  it('不减弱且调用方要平滑时才 smooth', () => {
    expect(scrollBehavior(false)).toBe('smooth');
    expect(scrollBehavior(false, true)).toBe('smooth');
  });

  it('调用方自己说不要平滑时照办', () => {
    expect(scrollBehavior(false, false)).toBe('auto');
  });
});

describe('时长与曲线 token', () => {
  /** 退场比入场短（用户已经决定离开了）。设计口径是 ×0.67，取整落在 120 上 */
  it('退场明显短于入场，落在 0.6–0.7 之间', () => {
    const ratio = MO.exit / MO.base;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.7);
  });

  it('单次动效 ≤300ms，只有落章与编排两个点名的例外', () => {
    for (const [name, ms] of Object.entries(MO)) {
      if (name === 'seal' || name === 'track') continue;
      expect(ms, name).toBeLessThanOrEqual(300);
    }
    expect(MO.seal).toBe(420);
    expect(MO.track).toBe(900);
  });

  it('sec() 是 gsap 侧的唯一换算口，不在调用处现除 1000', () => {
    expect(sec(MO.base)).toBeCloseTo(0.18, 6);
  });

  it('cubicBezier 与 CSS 同名：两端钉死、单调不回头', () => {
    const f = cubicBezier(...EASE_BEZIER.out);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = f(p);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
    // out 曲线前半程走得比线性快，否则它就不是 out
    expect(f(0.25)).toBeGreaterThan(0.25);
  });

  it('落章是全站唯一带过冲的曲线，而且真的冲出去了', () => {
    const seal = EASE.seal;
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => seal(i / 100)));
    expect(peak).toBeGreaterThan(1);
    // 其余两条一步都不许冲出 [0,1]——「不弹、不飘」
    for (const name of ['out', 'in'] as const) {
      for (let i = 0; i <= 100; i++) {
        const v = EASE[name](i / 100);
        expect(v, `${name}@${i}`).toBeLessThanOrEqual(1 + 1e-9);
        expect(v, `${name}@${i}`).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('进度专用曲线是线性——进度用 ease 会撒谎', () => {
    expect(EASE.lin(0.37)).toBe(0.37);
  });
});

describe('触觉出口', () => {
  it('没有 vibrate 的环境（iOS Safari）直接返回 false，不抛', () => {
    (globalThis as { navigator?: unknown }).navigator = {};
    expect(haptic(HAPTIC.actionDone)).toBe(false);
  });

  /**
   * **走的是能力判断，不是「先调用再接异常」。**
   * 两条路的返回值一模一样（都是 false），只有这一条能把它们分开——
   * 而 iOS Safari 是一半移动用户，每次触觉都构造一个异常再吞掉，
   * 既白付代价，也让 devtools 的「断在抛出处」模式变成噪音刷屏。
   */
  it('不支持时连 vibrate 这个属性都不去读', () => {
    const seen: string[] = [];
    (globalThis as { navigator?: unknown }).navigator = new Proxy(
      {},
      {
        has: (_t, k) => {
          seen.push(`has:${String(k)}`);
          return false;
        },
        get: (_t, k) => {
          seen.push(`get:${String(k)}`);
          return undefined;
        },
      },
    );
    expect(haptic(HAPTIC.actionDone)).toBe(false);
    expect(seen).toContain('has:vibrate');
    expect(seen).not.toContain('get:vibrate');
  });

  it('有 vibrate 就照传，模式原样递过去', () => {
    const vibrate = vi.fn(() => true);
    (globalThis as { navigator?: unknown }).navigator = { vibrate };
    expect(haptic(HAPTIC.groupClear)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(HAPTIC.groupClear);
  });

  it('vibrate 抛异常（被用户手势策略拦下）也只是没震，不炸页面', () => {
    (globalThis as { navigator?: unknown }).navigator = {
      vibrate: () => {
        throw new Error('NotAllowedError');
      },
    };
    expect(haptic(HAPTIC.seal)).toBe(false);
  });
});
