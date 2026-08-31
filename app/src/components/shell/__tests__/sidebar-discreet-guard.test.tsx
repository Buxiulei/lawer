/**
 * 侧栏底部那个「低调模式」菜单项必须和顶栏眼睛钮走同一道方向不对称的闸：
 * **单击开、按住 600ms 才关**，桌面鼠标按住同样算数。
 *
 * 它从前是 onClick={toggle} 双向直切——顶栏那条路堵上了，这条还开着，
 * 安全阀就等于没装。所以这里盯的是「这个入口确实接上了那份共用判定」。
 *
 * 本仓库 vitest 跑的是 node 环境、没有 DOM，所以直接把组件当普通函数调用，
 * 从它返回的元素上取 props 触发事件——DiscreetMenuItem 自己不含 React hook
 * （全托给 useDiscreetToggle），可以这样跑。谁把它换回 onClick 直切、或往组件里
 * 塞了别的 hook，这里就红。判定本身（600ms、中途松手、closed 标记）
 * 由 discreet-press.test.ts 单独盯。
 */
import type { ReactElement, ReactNode } from 'react';
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

// 组件若绕过 hook 直接吃 context（就是修复前那个写法），让它照样跑得起来——
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

const { DiscreetMenuItem } = await import('../AppSidebar');

interface MenuButtonProps {
  className: string;
  'aria-label': string;
  tooltip: string;
  children: ReactNode;
  onClick?: unknown;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel?: () => void;
  onPointerLeave?: () => void;
}

/** SidebarMenuItem 包着唯一一个 SidebarMenuButton，取的就是后者收到的 props */
function menuButton(): MenuButtonProps {
  const item = DiscreetMenuItem() as unknown as ReactElement<{
    children: ReactElement<MenuButtonProps>;
  }>;
  return item.props.children.props;
}

beforeEach(() => {
  vi.useFakeTimers();
  bus.state = { timer: null, closed: false };
  bus.holding = false;
  bus.setDiscreet.mockClear();
  bus.hint.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('侧栏低调模式菜单项', () => {
  it('单击开启生效', () => {
    bus.discreet = false;
    const props = menuButton();
    props.onPointerDown();
    props.onPointerUp();
    expect(bus.setDiscreet.mock.calls).toEqual([[true]]);
  });

  it('单击关闭无效，只给提示', () => {
    bus.discreet = true;
    const props = menuButton();
    props.onPointerDown();
    props.onPointerUp();
    expect(bus.setDiscreet).not.toHaveBeenCalled();
    expect(bus.hint).toHaveBeenCalledTimes(1);
  });

  // 推进时间一律写字面量 599/600，不写 HOLD_MS±n：拿被测的那个数当量尺，
  // 把 600 改成 1 也照样全绿。理由与 discreet-press.test.ts 里那条相同。
  it('鼠标按住满 600ms 才关得掉（桌面不给折扣）', () => {
    bus.discreet = true;
    const props = menuButton();
    props.onPointerDown();
    vi.advanceTimersByTime(599);
    expect(bus.setDiscreet).not.toHaveBeenCalled(); // 差 1ms 都不算
    vi.advanceTimersByTime(1);
    expect(bus.setDiscreet.mock.calls).toEqual([[false]]);
  });

  it('中途松手不关', () => {
    bus.discreet = true;
    const props = menuButton();
    props.onPointerDown();
    vi.advanceTimersByTime(500);
    props.onPointerUp();
    vi.advanceTimersByTime(1000);
    expect(bus.setDiscreet).not.toHaveBeenCalled();
  });

  it('没有 onClick 旁路（有的话单击就绕过了长按）', () => {
    bus.discreet = true;
    expect(menuButton().onClick).toBeUndefined();
  });

  it('指针离开 / 被取消都撤掉计时（手滑开了不能还在偷偷倒数）', () => {
    for (const key of ['onPointerLeave', 'onPointerCancel'] as const) {
      bus.discreet = true;
      bus.state = { timer: null, closed: false };
      bus.setDiscreet.mockClear();
      const props = menuButton();
      props.onPointerDown();
      props[key]?.();
      vi.advanceTimersByTime(1000);
      expect(bus.setDiscreet, key).not.toHaveBeenCalled();
    }
  });

  it('按住期间缩一下，让人看见长按在走（不然像点了没反应）', () => {
    bus.discreet = true;
    expect(menuButton().className).not.toContain('scale-90');
    bus.holding = true;
    expect(menuButton().className).toContain('scale-90');
  });

  it('加缩放过渡时不许顶掉基类的配色过渡', () => {
    bus.discreet = true;
    // tailwind-merge 把 transition-* 当同一组：只写 transition-transform，
    // SidebarMenuButton 基类那串 transition-[...background-color,color] 会被整条顶掉，
    // hover / 选中的配色过渡就没了。所以属性必须一条条列全。
    expect(menuButton().className).toMatch(
      /transition-\[[^\]]*background-color[^\]]*transform[^\]]*\]/,
    );
  });

  it('按住期间不许被浏览器手势 / 选中抢走（touch-none + select-none）', () => {
    bus.discreet = true;
    const className = menuButton().className;
    expect(className).toContain('touch-none');
    expect(className).toContain('select-none');
  });

  it.each([true, false])(
    '无障碍名逐字包含可见文字（WCAG 2.5.3），discreet=%s',
    (discreet) => {
      bus.discreet = discreet;
      const props = menuButton();
      // 可见文字是「低调模式」和「开 / 关」两个 span 直接相邻，中间没有空格。
      // pressProps 自带的 aria-label 是给纯图标钮写的，套上来会断掉这个子串匹配，
      // 让语音控制的人念着屏幕上的字点不动它——所以组件必须覆盖掉它。
      const visible = renderToStaticMarkup(<>{props.children}</>).replace(/<[^>]*>/g, '');
      expect(visible).toBe(discreet ? '低调模式开' : '低调模式关');
      expect(props['aria-label']).toContain(visible);
    },
  );

  it('已开启时，名字和 tooltip 都得说清要按住才关得掉', () => {
    bus.discreet = true;
    const props = menuButton();
    expect(props['aria-label']).toContain('按住');
    expect(props.tooltip).toContain('按住');
  });
});
