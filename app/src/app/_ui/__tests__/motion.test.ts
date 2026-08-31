/**
 * 动效基座的守卫（A 路 gsap 原语 + B 路 WAAPI 原语，合并后一处测）。
 *
 * 这一组盯的全是**失败时画面看起来完全正常**的东西：
 * 减弱动效没降级、CSS 与 JS 的 token 各走各的、`vibrate` 在 iOS 上抛异常、
 * WAAPI 的「点名例外」被顺手也降级掉。没有一条会报错，全靠肉眼在真机上撞见——所以由测试钉着。
 *
 * 【减弱动效的方向】SSR / 取不到 matchMedia 时默认 **true（偏向不动）**：
 * 前庭敏感者被首屏甩一下是真实生理伤害，取不准时偏向不伤人（manager 2026-08-31 裁定）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EASE,
  EASE_BEZIER,
  EASE_CSS,
  HAPTIC,
  MO,
  MOTION,
  REDUCE_QUERY,
  animate,
  animateAlways,
  cubicBezier,
  haptic,
  hapticEnabled,
  prefersReducedMotion,
  scrollBehavior,
  sec,
  setHapticEnabled,
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

/** 装一个只认 `(prefers-reduced-motion: reduce)` 的假 matchMedia（B 路用）。 */
function stubWindow(reduce: boolean) {
  (globalThis as Record<string, unknown>).window = {
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce') && reduce,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
}

/** 记下每次 `el.animate()` 拿到的 options。 */
function fakeElement() {
  const calls: KeyframeAnimationOptions[] = [];
  const el = {
    animate: (_: Keyframe[], options: KeyframeAnimationOptions) => {
      calls.push(options);
      return { cancel: () => {} } as unknown as Animation;
    },
  };
  return { el: el as unknown as Element, calls };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { localStorage?: unknown }).localStorage;
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

describe('程序化滚动的降级（A 路：调用方传入 reduce）', () => {
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

describe('程序化滚动的降级（B 路：无参，自读 prefersReducedMotion）', () => {
  it('常态是 smooth（正对照，否则下面那条恒真、等于没守）', () => {
    stubWindow(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('减弱动效时换成 auto（瞬移），不是「滚得快一点」', () => {
    stubWindow(true);
    expect(scrollBehavior()).toBe('auto');
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

  it('EASE（gsap 函数）与 EASE_CSS（WAAPI 字符串）是两套，别混用', () => {
    // A 路喂 gsap 的是函数，B 路喂 WAAPI easing 的是 cubic-bezier 字符串——类型不相容，双名分离
    expect(typeof EASE.out).toBe('function');
    expect(EASE_CSS.out).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(EASE_CSS.lin).toBe('linear');
  });
});

describe('animate（B 路）—— 降级是「跳到终态」，不是「缩短」', () => {
  it('常态原样把时长与缓动交给 WAAPI（正对照）', () => {
    stubWindow(false);
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION.base,
      easing: EASE_CSS.out,
      delay: 40,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].duration).toBe(MOTION.base);
    expect(calls[0].delay).toBe(40);
    expect(calls[0].easing).toBe(EASE_CSS.out);
  });

  it('减弱动效时时长与延迟一律压成 0——**不是 0.01ms，是 0**', () => {
    stubWindow(true);
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION.base,
      easing: EASE_CSS.out,
      delay: 40,
    });
    expect(calls[0].duration).toBe(0);
    expect(calls[0].delay).toBe(0);
  });

  it('目标不存在 / 环境没有 WAAPI 时安静地什么也不做，不抛', () => {
    stubWindow(false);
    expect(animate(null, [], { duration: 1 })).toBeNull();
    expect(animate({} as unknown as Element, [], { duration: 1 })).toBeNull();
  });
});

describe('animateAlways（B 路）—— 点名例外，不随减弱动效降级', () => {
  /*
   * 【为什么必须有这一支】降级 ≠ 全关。长按关低调那道 600ms 的进度环
   * 是**进度反馈不是装饰**：没有位移、没有前庭刺激，去掉它用户就不知道
   * 还要按多久。而 CSS 写不出这个例外——globals.css 那条全局 !important
   * 会把任何 CSS 动画的时长压掉，所以它只能是 WAAPI 的这一支。
   */
  it('减弱动效下时长原样保留', () => {
    stubWindow(true);
    const { el, calls } = fakeElement();
    animateAlways(el, [{ strokeDashoffset: '125' }, { strokeDashoffset: '0' }], {
      duration: 600,
      easing: EASE_CSS.lin,
    });
    expect(calls[0].duration).toBe(600);
    expect(calls[0].easing).toBe(EASE_CSS.lin);
  });

  it('常态也一样（正对照：这一支两种情况下行为相同）', () => {
    stubWindow(false);
    const { el, calls } = fakeElement();
    animateAlways(el, [], { duration: 600 });
    expect(calls[0].duration).toBe(600);
  });
});

describe('触觉出口：能力判断，不「先调用再接异常」', () => {
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

describe('触觉是另一个通道，但认用户自己的触觉开关', () => {
  function stubNavigator(vibrate: ((p: number | number[]) => boolean) | null) {
    (globalThis as Record<string, unknown>).navigator = vibrate ? { vibrate } : {};
  }

  function stubStorage() {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  }

  it('**不随 prefers-reduced-motion 关闭**——慌乱时用户不看屏，指尖确认更可靠', () => {
    stubWindow(true);
    stubStorage();
    const vibrate = vi.fn(() => true);
    stubNavigator(vibrate);
    expect(haptic(20)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(20);
  });

  it('用户自己的开关能关掉它（关的是触觉开关，不是动效开关）', () => {
    stubWindow(false);
    stubStorage();
    const vibrate = vi.fn(() => true);
    stubNavigator(vibrate);
    expect(hapticEnabled()).toBe(true); // 正对照：默认开
    setHapticEnabled(false);
    expect(hapticEnabled()).toBe(false);
    expect(haptic(20)).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('iOS Safari 没有 navigator.vibrate：安静地回 false，不抛', () => {
    stubStorage();
    stubNavigator(null);
    expect(haptic([10, 40, 10])).toBe(false);
  });

  it('读不到 localStorage（隐私模式）时按「开」算，不是按「关」算', () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(hapticEnabled()).toBe(true);
    expect(() => setHapticEnabled(false)).not.toThrow();
  });
});
