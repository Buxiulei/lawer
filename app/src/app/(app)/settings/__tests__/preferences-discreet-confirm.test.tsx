/**
 * 设置页的低调模式开关：**开启直切，关闭要先过一次确认**。
 *
 * 这里跟顶栏 / 侧栏的 600ms 长按是两种药：人是特地翻进设置来改偏好的，不是在地铁上
 * 误蹭到，所以不套长按；但关掉的后果（余额、公司名当场明文）比多点一下重得多，
 * 方向仍然不对称。从前这里是 onCheckedChange={setDiscreet} 双向秒切。
 *
 * 本仓库 vitest 跑的是 node 环境、没有 DOM，所以直接把组件当普通函数调用，
 * 从它返回的元素树上取 props 触发。只替掉外部的 React 状态层（useState / useDiscreet），
 * **判定与接线仍是组件里真的那一份**——谁把 onCheckedChange 接回 setDiscreet，
 * 或者给 Switch 补一条绕过确认的旁路，这里就红。
 */
import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bus = {
  discreet: false,
  confirmOpen: false,
  setDiscreet: vi.fn<(on: boolean) => void>(),
  setConfirmOpen: vi.fn<(on: boolean) => void>(),
};

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({
    discreet: bus.discreet,
    setDiscreet: bus.setDiscreet,
    toggle: () => bus.setDiscreet(!bus.discreet),
  }),
}));

// useDiscreetOffConfirm 里只有这一个 useState（确认框开合），替掉它就能任意摆位置
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useState: () => [bus.confirmOpen, bus.setConfirmOpen] };
});

const { DiscreetPreference } = await import('../_components/PreferencesCard');

type Props = Record<string, unknown>;

/** 在返回的元素树里找第一个带某个 prop 的元素，免得靠下标写死结构 */
function findByProp(node: ReactNode, key: string): Props | null {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const hit = findByProp(child, key);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Props;
  if (key in props) return props;
  return findByProp(props.children as ReactNode, key);
}

function parts() {
  const tree = DiscreetPreference() as unknown as ReactNode;
  const toggle = findByProp(tree, 'onCheckedChange');
  const dialog = findByProp(tree, 'confirmLabel');
  if (!toggle) throw new Error('元素树里没有找到低调模式开关');
  if (!dialog) throw new Error('元素树里没有找到关闭确认框');
  return {
    toggle,
    dialog,
    onCheckedChange: toggle.onCheckedChange as (next: boolean) => void,
    onConfirm: dialog.onConfirm as () => void,
    onCancel: dialog.onCancel as () => void,
  };
}

beforeEach(() => {
  bus.discreet = false;
  bus.confirmOpen = false;
  bus.setDiscreet.mockClear();
  bus.setConfirmOpen.mockClear();
});

describe('设置页低调模式开关', () => {
  it('开启方向直切，不弹确认（要藏的时候别再拦一道）', () => {
    bus.discreet = false;
    parts().onCheckedChange(true);
    expect(bus.setDiscreet.mock.calls).toEqual([[true]]);
    expect(bus.setConfirmOpen).not.toHaveBeenCalled();
  });

  it('关闭方向不直切，只弹确认', () => {
    bus.discreet = true;
    parts().onCheckedChange(false);
    expect(bus.setDiscreet).not.toHaveBeenCalled(); // 这一下不许把打码撤掉
    expect(bus.setConfirmOpen.mock.calls).toEqual([[true]]);
  });

  it('按了确认才真的关', () => {
    bus.discreet = true;
    bus.confirmOpen = true;
    parts().onConfirm();
    expect(bus.setDiscreet.mock.calls).toEqual([[false]]);
    expect(bus.setConfirmOpen.mock.calls).toEqual([[false]]); // 顺手收起弹窗
  });

  it('取消就什么都不动，开关还是开着的', () => {
    bus.discreet = true;
    bus.confirmOpen = true;
    const { onCancel, toggle } = parts();
    onCancel();
    expect(bus.setDiscreet).not.toHaveBeenCalled();
    expect(bus.setConfirmOpen.mock.calls).toEqual([[false]]);
    // checked 绑的是真状态，没关成就不许自己先翻过去
    expect(toggle.checked).toBe(true);
  });

  it('弹窗开合跟着 confirmOpen 走', () => {
    bus.discreet = true;
    expect(parts().dialog.open).toBe(false);
    bus.confirmOpen = true;
    expect(parts().dialog.open).toBe(true);
  });

  it('开关上没有绕过确认的旁路', () => {
    bus.discreet = true;
    const { toggle } = parts();
    for (const key of ['onClick', 'onChange', 'onPointerDown', 'onKeyDown']) {
      expect(toggle[key], key).toBeUndefined();
    }
  });

  it('确认文案写明后果，按钮不许只写「确定」', () => {
    bus.discreet = true;
    const { dialog } = parts();
    expect(dialog.description).toContain('关闭后余额等敏感信息将明文显示');
    expect(dialog.confirmLabel).toContain('明文');
    expect(dialog.confirmLabel).not.toBe('确定');
    // 取消键得让人看出「保持现状」，不能是含糊的「取消」
    expect(dialog.cancelLabel).toBe('保持开启');
  });
});
