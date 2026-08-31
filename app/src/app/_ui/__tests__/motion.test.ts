/**
 * 减弱动效（prefers-reduced-motion）降级守卫。
 *
 * 【这组存在的理由】
 * globals.css 底部那条 `* { animation-duration: .01ms !important }` 只管 CSS，
 * **管不到 JS**——`window.scrollTo({behavior:'smooth'})` 和 `Element.animate()`
 * 在减弱动效下照跑，而程序化平滑滚动正是前庭敏感者最难受的那一类。
 * 所以 JS 侧的降级只有 `_ui/motion.ts` 一个真源，这组就钉在那个真源上。
 *
 * 【变异核】把 `animate()` 里的 `prefersReducedMotion()` 分支删掉、
 * 或让 `scrollBehavior()` 恒回 'smooth'，下面必红。反过来，让 `animateAlways()`
 * 也跟着降级（那就等于把长按进度环也关掉了），「点名例外」那两条必红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EASE,
  MOTION,
  animate,
  animateAlways,
  haptic,
  hapticEnabled,
  prefersReducedMotion,
  scrollBehavior,
  setHapticEnabled,
} from '../motion';

type Listener = () => void;

/** 装一个只认 `(prefers-reduced-motion: reduce)` 的假 matchMedia。 */
function stubWindow(reduce: boolean) {
  const listeners = new Set<Listener>();
  (globalThis as Record<string, unknown>).window = {
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce') && reduce,
      addEventListener: (_: string, cb: Listener) => listeners.add(cb),
      removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    }),
  };
  return listeners;
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
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).navigator;
  delete (globalThis as Record<string, unknown>).localStorage;
  vi.restoreAllMocks();
});

describe('prefersReducedMotion', () => {
  it('服务端（没有 window）回 false——读不准时偏向照常播，不偏向全关', () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it('系统开了减弱动效就回 true', () => {
    stubWindow(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('没开就回 false（正对照：假 matchMedia 本身是能回 false 的）', () => {
    stubWindow(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('scrollBehavior —— 程序化滚动的降级', () => {
  it('常态是 smooth（正对照，否则下面那条恒真、等于没守）', () => {
    stubWindow(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('减弱动效时换成 auto（瞬移），不是「滚得快一点」', () => {
    stubWindow(true);
    expect(scrollBehavior()).toBe('auto');
  });
});

describe('animate —— 降级是「跳到终态」，不是「缩短」', () => {
  it('常态原样把时长与缓动交给 WAAPI（正对照）', () => {
    stubWindow(false);
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION.base,
      easing: EASE.out,
      delay: 40,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].duration).toBe(MOTION.base);
    expect(calls[0].delay).toBe(40);
    expect(calls[0].easing).toBe(EASE.out);
  });

  it('减弱动效时时长与延迟一律压成 0——**不是 0.01ms，是 0**', () => {
    stubWindow(true);
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION.base,
      easing: EASE.out,
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

describe('animateAlways —— 点名例外，不随减弱动效降级', () => {
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
      easing: EASE.lin,
    });
    expect(calls[0].duration).toBe(600);
    expect(calls[0].easing).toBe(EASE.lin);
  });

  it('常态也一样（正对照：这一支两种情况下行为相同）', () => {
    stubWindow(false);
    const { el, calls } = fakeElement();
    animateAlways(el, [], { duration: 600 });
    expect(calls[0].duration).toBe(600);
  });
});

describe('haptic —— 触觉是另一个通道', () => {
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
