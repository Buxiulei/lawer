/**
 * 底部固定层高度真源（SYS-06）的守卫。
 *
 * 立这组的由头：底部有两层——常驻 Tab 条，加上只有部分页面才有的 sticky 操作条。
 * 原来悬浮低调钮写死「Tab + 76px」、低调提示条写死「Tab + 12px」，
 * 谁都不知道操作条实际多高（首诊 149px、问它 96px），于是 393 视口下
 * 低调钮正压在「下一步」上——实测重叠 40×32，且 z-50 > z-30 连点击都被截走。
 *
 * 现在只有一个数 `--bottom-bar-h`。这组钉三件事：
 *   1. 写：sticky 操作条挂载期间把**实测**高写进去，条高变了要跟着改；
 *   2. 读：低调钮与提示条都读它，且只有一档（不再猜页面有没有条）；
 *   3. 回退：没有操作条的页面落回 Tab 那条的高。
 *
 * 【量具边界】本套件跑在 node 环境（仓库没有 jsdom），所以 trackBottomBar 用替身
 * 元素 + 替身 ResizeObserver 驱动，验的是**这个函数的行为**；「真的量到 149px、
 * 真的躲开了按钮」由 393 视口的真浏览器几何量法给证据，不由这里冒充。
 * 跨过这条缝的接线（写在 documentElement 上）用源码断言钉住，见文件末尾。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 这几个组件都要 useDiscreet，SSR 下拿不到 Provider；这里只看标记不看低调状态
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));

import { ToastProvider } from '@/components/ui/Toast';
import { BOTTOM_BAR_VAR, bottomBarValue, trackBottomBar } from '../bottomBar';
import { PanicButton } from '../PanicButton';
import { StickyBottomBar } from '../StickyBottomBar';

const SRC_ROOT = path.resolve(__dirname, '../../..');

describe('bottomBarValue', () => {
  it('总高 = Tab 那条 + 实测条高', () => {
    expect(bottomBarValue(149)).toBe('calc(var(--tab-bar-h) + 149px)');
    expect(bottomBarValue(96)).toBe('calc(var(--tab-bar-h) + 96px)');
  });

  it('亚像素往上取整——这个值是给别人躲开用的，宁可多让半像素', () => {
    expect(bottomBarValue(95.2)).toBe('calc(var(--tab-bar-h) + 96px)');
    expect(bottomBarValue(148.01)).toBe('calc(var(--tab-bar-h) + 149px)');
  });
});

/** 替身观察器：记下建了几个、观察的是谁，并把回调留出来手动触发。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: unknown[] = [];
  disconnected = false;
  constructor(readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

/** 替身根元素：只实现 trackBottomBar 用到的 setProperty / removeProperty。 */
function fakeRoot() {
  const props = new Map<string, string>();
  const root = {
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
  } as unknown as HTMLElement;
  return { root, props };
}

function fakeBar(height: number) {
  const state = { height };
  const el = {
    getBoundingClientRect: () => ({ height: state.height }),
  } as unknown as HTMLElement;
  return { el, state };
}

describe('trackBottomBar', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('挂上就把实测高写进 --bottom-bar-h', () => {
    const { root, props } = fakeRoot();
    const { el } = fakeBar(149);

    trackBottomBar(el, root);

    expect(props.get(BOTTOM_BAR_VAR)).toBe('calc(var(--tab-bar-h) + 149px)');
  });

  it('盯着这条 bar 本身，而不是量一次就算完', () => {
    const { root } = fakeRoot();
    const { el } = fakeBar(149);

    trackBottomBar(el, root);

    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed).toEqual([el]);
  });

  it('条高变了跟着改——首诊那条会因为提示行出现/消失跳一档', () => {
    const { root, props } = fakeRoot();
    const { el, state } = fakeBar(149);

    trackBottomBar(el, root);
    state.height = 96;
    FakeResizeObserver.instances[0].cb();

    expect(props.get(BOTTOM_BAR_VAR)).toBe('calc(var(--tab-bar-h) + 96px)');
  });

  it('卸载时删掉变量并停掉观察器，不把上一页的条高带到下一页', () => {
    const { root, props } = fakeRoot();
    const { el } = fakeBar(149);

    const stop = trackBottomBar(el, root);
    stop();

    // 删掉才会回落到 globals.css 的 :root 默认值（只有 Tab 那条）；
    // 写回一个字面值等于把回退逻辑抄第二遍
    expect(props.has(BOTTOM_BAR_VAR)).toBe(false);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });
});

describe('三处固定层读的是同一个数', () => {
  it('sticky 操作条停在 Tab 那条之上，调用方的皮肤类照留', () => {
    const html = renderToStaticMarkup(
      <StickyBottomBar className="border-t border-line px-4">内容</StickyBottomBar>,
    );
    expect(html).toContain('bottom-[var(--tab-bar-h)]');
    expect(html).toContain('border-t');
  });

  it('悬浮低调钮抬在 --bottom-bar-h 之上，且只有一档', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <PanicButton />
      </ToastProvider>,
    );
    expect(html).toContain('bottom-[calc(var(--bottom-bar-h)+8px)]');
  });

  it('低调提示条读的是同一个 --bottom-bar-h', () => {
    const html = renderToStaticMarkup(<ToastProvider>{null}</ToastProvider>);
    expect(html).toContain('bottom-[calc(var(--bottom-bar-h)+12px)]');
  });
});

describe('回退与入口', () => {
  it('globals.css 给出 Tab 条高，并让 --bottom-bar-h 默认回退到它', () => {
    const css = fs.readFileSync(path.join(SRC_ROOT, 'app/globals.css'), 'utf8');
    // 没有这两行，读变量的地方会拿到 invalid，bottom 直接掉回 auto——
    // 低调钮会从拇指区飞到页面顶部，而且没有任何报错
    expect(css).toMatch(/--tab-bar-h:\s*calc\(56px \+ env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/--bottom-bar-h:\s*var\(--tab-bar-h\)/);
  });

  /**
   * 底部偏移只允许从变量来。放行 `56px` 就等于把 Tab 条高抄了第二遍，
   * 下次 h-14 改成 h-16 时改一处漏一处——SYS-06 就是这么来的。
   */
  const FIXED_LAYER_FILES = [
    'components/shell/AppShell.tsx',
    'components/shell/PanicButton.tsx',
    'components/shell/StickyBottomBar.tsx',
    'components/ui/Toast.tsx',
    'app/(app)/intake/_components/IntakeFlow.tsx',
    'app/(app)/case/[id]/_components/Composer.tsx',
  ];

  it.each(FIXED_LAYER_FILES)('%s 不再自己写死 Tab 条高', (rel) => {
    const src = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
    expect(
      src.includes('56px'),
      `${rel} 里出现了字面量 56px。\n` +
        `为什么不行：那是底部 Tab 条的高，已经由 globals.css 的 --tab-bar-h 定义；` +
        `再抄一遍就会出现两个互不感知的答案，正是 SYS-06 的病因。\n` +
        `怎么办：位置用 bottom-[var(--tab-bar-h)]，要躲开整个底部固定层用 var(--bottom-bar-h)。`,
    ).toBe(false);
  });

  /**
   * 这条是**源码断言**，不是行为断言：本套件没有 DOM，跑不了 layout effect，
   * 「写到哪个元素上」这一段没有可执行的判据盖住。它盯的是那条缝——
   * 写错根元素（比如写到 bar 自己身上）会让全站读到的都是默认值，而且不报错。
   */
  it('StickyBottomBar 把实测高写在 documentElement 上', () => {
    const src = fs.readFileSync(
      path.join(SRC_ROOT, 'components/shell/StickyBottomBar.tsx'),
      'utf8',
    );
    expect(src).toContain('trackBottomBar(el, document.documentElement)');
  });
});
