'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { useToast } from '@/components/ui/Toast';

/** 关闭要按住多久。开启没有门槛，关闭才有——两个方向的代价不对称是故意的。 */
export const HOLD_MS = 600;

/** 跨渲染存活的按压状态。放在 useRef 里，不能每次渲染重建，理由见 createDiscreetPress。 */
export interface HoldState {
  timer: ReturnType<typeof setTimeout> | null;
  /** 长按已经生效：随后的 pointerup 不要再当成单击处理 */
  closed: boolean;
}

/** 撤掉计时与按住态。松手、移开、取消、卸载都走这里。 */
export function clearHold(state: HoldState, setHolding: (on: boolean) => void) {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  setHolding(false);
}

type Preventable = { preventDefault: () => void };

interface PressDeps {
  state: HoldState;
  discreet: boolean;
  setDiscreet: (on: boolean) => void;
  /** 已开启时单击给的提示：不动状态，只说清怎么才关得掉 */
  hint: () => void;
  setHolding: (on: boolean) => void;
  holdMs?: number;
}

/**
 * 低调模式开关的方向不对称判定，脱开 React 单独写好让它能被直接测。
 *
 * **单击开**（慌的时候没有第二次机会），**按住 0.6 秒才关**（在地铁上误蹭一下就把金额
 * 亮出来，比多按半秒糟糕得多），中途松手不动作。已开启时单击只给一句提示。
 * 键盘回车两个方向都直切——长按防的是误触，键盘不存在这个问题。
 *
 * `state` 必须由调用方跨渲染持有：长按期间 setHolding 会触发重渲染换掉这组处理器，
 * closed 标记若跟着重建，长按刚关完的那一下松手会被当成单击、立刻又把低调模式开回来。
 */
export function createDiscreetPress({
  state,
  discreet,
  setDiscreet,
  hint,
  setHolding,
  holdMs = HOLD_MS,
}: PressDeps) {
  const stopHold = () => clearHold(state, setHolding);
  return {
    'aria-pressed': discreet,
    'aria-label': discreet ? '关闭低调模式（按住不放）' : '开启低调模式',
    onPointerDown: () => {
      state.closed = false;
      if (!discreet) return;
      setHolding(true);
      state.timer = setTimeout(() => {
        state.closed = true;
        stopHold();
        setDiscreet(false);
      }, holdMs);
    },
    onPointerUp: () => {
      stopHold();
      if (state.closed) return;
      if (discreet) hint();
      else setDiscreet(true);
    },
    onPointerCancel: stopHold,
    onPointerLeave: stopHold,
    onContextMenu: (e: Preventable) => e.preventDefault(),
    onKeyDown: (e: Preventable & { key: string }) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setDiscreet(!discreet);
    },
  };
}

/**
 * 低调模式开关的共用判定 + 状态。顶栏眼睛钮和拇指区 PanicButton 都用这一份，
 * 谁也别再自己写一遍开关逻辑——两处各写一遍，就是顶栏当初单击秒破打码的由来。
 *
 * 返回的 `holding` 供调用方做长按进度反馈（按住期间缩一下），`pressProps` 整组摊到
 * `<button>` 上，别只挑其中几个：漏掉 onPointerLeave/onPointerCancel 会让手指滑开后
 * 计时还在跑，漏掉 onContextMenu 则长按会弹出系统菜单。
 */
export function useDiscreetToggle() {
  const { discreet, setDiscreet } = useDiscreet();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const state = useRef<HoldState>({ timer: null, closed: false }).current;

  // 身份必须稳定：它一变，下面的 effect 就成了「每次渲染清一次计时器」，
  // 而按住期间 setHolding 正好会触发渲染——长按永远走不到 600ms。
  const stopHold = useCallback(() => clearHold(state, setHolding), [state]);
  useEffect(() => stopHold, [stopHold]);

  const hint = useCallback(() => toast('长按可以关闭', 'neutral', '长按可以关闭'), [toast]);

  return {
    discreet,
    holding,
    pressProps: createDiscreetPress({ state, discreet, setDiscreet, hint, setHolding }),
  };
}
