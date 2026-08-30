/**
 * 低调模式开关的方向不对称判定本体：单击开、按住 600ms 才关。
 * 这是隐私安全阀——「关」这个方向一旦变回单击即生效，地铁上蹭一下就把余额和手机号亮出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, createDiscreetPress, type HoldState } from '../useDiscreetToggle';

/** 一次「渲染」：state 跨渲染留着，其余按当前 discreet 值重建，和 React 里一样 */
function press(state: HoldState, discreet: boolean) {
  const setDiscreet = vi.fn<(on: boolean) => void>();
  const hint = vi.fn();
  const props = createDiscreetPress({
    state,
    discreet,
    setDiscreet,
    hint,
    setHolding: () => {},
  });
  return { props, setDiscreet, hint };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('低调模式开关的方向不对称', () => {
  it('关着的时候单击立刻开——慌的时候没有第二次机会', () => {
    const state: HoldState = { timer: null, closed: false };
    const { props, setDiscreet } = press(state, false);
    props.onPointerDown();
    props.onPointerUp();
    expect(setDiscreet.mock.calls).toEqual([[true]]);
  });

  it('开着的时候单击关不掉，只给一句「长按可以关闭」', () => {
    const state: HoldState = { timer: null, closed: false };
    const { props, setDiscreet, hint } = press(state, true);
    props.onPointerDown();
    props.onPointerUp();
    expect(setDiscreet).not.toHaveBeenCalled();
    expect(hint).toHaveBeenCalledTimes(1);
  });

  it('按住满 600ms 才关得掉', () => {
    const state: HoldState = { timer: null, closed: false };
    const { props, setDiscreet } = press(state, true);
    props.onPointerDown();
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(setDiscreet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setDiscreet.mock.calls).toEqual([[false]]);
  });

  it('不到 600ms 松手：什么也不发生，计时也不会晚点补上', () => {
    const state: HoldState = { timer: null, closed: false };
    const { props, setDiscreet } = press(state, true);
    props.onPointerDown();
    vi.advanceTimersByTime(HOLD_MS - 1);
    props.onPointerUp();
    vi.advanceTimersByTime(5000);
    expect(setDiscreet).not.toHaveBeenCalled();
  });

  it('手指滑出按钮同样中止，不会在按钮外边把它关掉', () => {
    const state: HoldState = { timer: null, closed: false };
    const { props, setDiscreet } = press(state, true);
    props.onPointerDown();
    props.onPointerLeave();
    vi.advanceTimersByTime(5000);
    expect(setDiscreet).not.toHaveBeenCalled();
  });

  it('长按关完那一下松手不会把它又开回来（closed 标记要跨渲染活着）', () => {
    const state: HoldState = { timer: null, closed: false };
    const holding = press(state, true);
    holding.props.onPointerDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(holding.setDiscreet.mock.calls).toEqual([[false]]);
    // 关掉后组件重渲染，处理器换成 discreet=false 那一组，手指这时才离开屏幕
    const released = press(state, false);
    released.props.onPointerUp();
    expect(released.setDiscreet).not.toHaveBeenCalled();
  });

  it('键盘回车两个方向都直切——长按防的是误触，键盘没这个问题', () => {
    const state: HoldState = { timer: null, closed: false };
    const on = press(state, true);
    on.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
    expect(on.setDiscreet.mock.calls).toEqual([[false]]);

    const off = press(state, false);
    off.props.onKeyDown({ key: ' ', preventDefault: () => {} });
    expect(off.setDiscreet.mock.calls).toEqual([[true]]);
  });
});
