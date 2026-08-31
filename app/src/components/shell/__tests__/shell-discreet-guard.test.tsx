/**
 * 两个低调模式钮（顶栏眼睛钮、拇指区悬浮钮）必须都走那道方向不对称的闸：
 * 单击开、按住 600ms 才关。顶栏那个从前是 onClick 直切，任意页面单击就把打码撤掉。
 *
 * 本仓库 vitest 跑的是 node 环境、没有 DOM，所以这里直接把组件当普通函数调用，
 * 拿它返回的元素 props 触发事件——两个组件自己不含 React hook（全托给 useDiscreetToggle），
 * 可以这样跑。谁把 hook 换回 onClick 直切、或往组件里塞了别的 hook，这里就红。
 * 判定本身（600ms、中途松手、closed 标记）由 discreet-press.test.ts 单独盯。
 */
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

const BUTTONS: Record<string, () => PressProps> = {
  '顶栏眼睛钮': () => DiscreetButton().props as PressProps,
  '拇指区悬浮钮': () => PanicButton().props as PressProps,
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
