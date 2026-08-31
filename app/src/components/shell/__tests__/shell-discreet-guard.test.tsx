/**
 * 两个低调模式钮（顶栏眼睛钮、拇指区悬浮钮）必须都走那道方向不对称的闸：
 * 单击开、按住 600ms 才关。顶栏那个从前是 onClick 直切，任意页面单击就把打码撤掉。
 *
 * 本仓库 vitest 跑的是 node 环境、没有 DOM。
 * **顶栏眼睛钮（DiscreetButton）自己不含 React hook**（全托给 useDiscreetToggle），
 * 所以直接把它当普通函数调用、拿返回元素的 props 触发事件——谁把 hook 换回 onClick 直切、
 * 或往里塞别的 hook，这里就红。判定本身（600ms、中途松手、closed 标记）由
 * discreet-press.test.ts 单独盯。
 *
 * **拇指区 PanicButton 现在多了一层动效表现层**（进度环 + 触觉 + 按压缩放，自带
 * useState/useRef/useEffect），不能再当普通函数调用读 .props。改用 renderToStaticMarkup
 * 渲染 ＋ 源码守卫钉同一条 intent：走 useDiscreetToggle 那道闸、指针委托给 pressProps、
 * 按钮上**没有 onClick 单击旁路**。它的长按判定同样由 discreet-press.test.ts 盯。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HoldState } from '../useDiscreetToggle';

const bus = {
  discreet: false,
  holding: false,
  state: { timer: null, closed: false } as HoldState,
  setDiscreet: vi.fn<(on: boolean) => void>(),
  hint: vi.fn(),
};

// 组件若绕过 hook 直接吃 context（就是修复前顶栏那个写法），让它照样跑得起来——
// 失败要落在「这个钮没有长按判定」上，而不是被一句 Provider 缺失的崩溃盖过去。
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({
    discreet: bus.discreet,
    setDiscreet: bus.setDiscreet,
    toggle: () => bus.setDiscreet(!bus.discreet),
  }),
}));

// 只替掉 React 状态那一层（useRef / holding / toast），判定仍是真的 createDiscreetPress
vi.mock('../useDiscreetToggle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../useDiscreetToggle')>();
  return {
    ...real,
    useDiscreetToggle: () => ({
      discreet: bus.discreet,
      holding: bus.holding,
      pressProps: real.createDiscreetPress({
        state: bus.state,
        discreet: bus.discreet,
        setDiscreet: bus.setDiscreet,
        hint: bus.hint,
        setHolding: () => {},
      }),
    }),
  };
});

const { PanicButton } = await import('../PanicButton');
const { DiscreetButton } = await import('../ShellHeader');

interface PressProps {
  className: string;
  onClick?: unknown;
  onPointerDown: () => void;
  onPointerUp: () => void;
}

// 顶栏眼睛钮仍是 hook-free 的纯函数，保留原来的「普通函数调用读 props」打法。
// 拇指区 PanicButton 见文件末尾的 render + 源码守卫（它已带自己的 hook，不能再这样调）。
const BUTTONS: Record<string, () => PressProps> = {
  '顶栏眼睛钮': () => DiscreetButton().props as PressProps,
};

beforeEach(() => {
  vi.useFakeTimers();
  bus.state = { timer: null, closed: false };
  bus.holding = false;
  bus.setDiscreet.mockClear();
  bus.hint.mockClear();
});
afterEach(() => vi.useRealTimers());

describe.each(Object.entries(BUTTONS))('%s', (_name, render) => {
  it('单击开启生效', () => {
    bus.discreet = false;
    const props = render();
    props.onPointerDown();
    props.onPointerUp();
    expect(bus.setDiscreet.mock.calls).toEqual([[true]]);
  });

  it('单击关闭无效，只给提示', () => {
    bus.discreet = true;
    const props = render();
    props.onPointerDown();
    props.onPointerUp();
    expect(bus.setDiscreet).not.toHaveBeenCalled();
    expect(bus.hint).toHaveBeenCalledTimes(1);
  });

  it('按住 600ms 关闭生效', () => {
    bus.discreet = true;
    const props = render();
    props.onPointerDown();
    vi.advanceTimersByTime(600);
    expect(bus.setDiscreet.mock.calls).toEqual([[false]]);
  });

  it('没有 onClick 旁路（有的话单击就绕过了长按）', () => {
    bus.discreet = true;
    expect(render().onClick).toBeUndefined();
  });

  it('按住期间缩一下，让人看见长按在走（不然像点了没反应）', () => {
    bus.discreet = true;
    expect(render().className).not.toContain('scale-90');
    bus.holding = true;
    expect(render().className).toContain('scale-90');
  });

  it('按住期间不许被浏览器手势抢走（touch-none + select-none）', () => {
    bus.discreet = true;
    const className = render().className;
    expect(className).toContain('touch-none');
    expect(className).toContain('select-none');
  });
});

// ─────────────────────────────────────────────────────────────
// 拇指区悬浮钮（PanicButton）：带动效表现层，验 render + 源码守卫
// ─────────────────────────────────────────────────────────────

describe('拇指区悬浮钮', () => {
  const PANIC_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'PanicButton.tsx'), 'utf8');

  it('渲染出 <button>，带 touch-none / select-none / lg:hidden，且不抛', () => {
    bus.discreet = false;
    const html = renderToStaticMarkup(<PanicButton />);
    expect(html).toContain('<button'); // 正对照：确实渲染出了按钮
    expect(html).toContain('touch-none');
    expect(html).toContain('select-none');
    expect(html).toContain('lg:hidden');
  });

  it('aria-pressed 跟着低调模式状态走', () => {
    bus.discreet = true;
    expect(renderToStaticMarkup(<PanicButton />)).toContain('aria-pressed="true"');
    bus.discreet = false;
    expect(renderToStaticMarkup(<PanicButton />)).toContain('aria-pressed="false"');
  });

  it('走 useDiscreetToggle 那道闸判开关（不自己读 useDiscreet 直判）', () => {
    expect(PANIC_SRC).toMatch(/useDiscreetToggle\(\)/);
    expect(PANIC_SRC).not.toMatch(/=\s*useDiscreet\(\)/);
  });

  it('指针处理器委托给 hook 的 pressProps（长按判定不在本层）', () => {
    expect(PANIC_SRC).toContain('pressProps.onPointerDown');
    expect(PANIC_SRC).toContain('pressProps.onPointerUp');
  });

  it('按钮上没有 onClick 单击旁路（有的话单击就绕过了长按闸）', () => {
    expect(PANIC_SRC).not.toMatch(/onClick=/);
  });
});
