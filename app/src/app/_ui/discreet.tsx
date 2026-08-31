'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { APP_TITLE, DISCREET_STORAGE_KEY, NEUTRAL_TITLE } from './bootstrap';
import { applyFavicon } from './favicon';
import { useHotkeys } from './hotkeys';

/** 双击 Esc 的间隔上限。超过就当成两次独立的 Esc。 */
const DOUBLE_ESC_MS = 400;

interface DiscreetContextValue {
  discreet: boolean;
  setDiscreet: (on: boolean) => void;
  toggle: () => void;
}

const DiscreetContext = createContext<DiscreetContextValue | null>(null);

export function DiscreetProvider({ children }: { children: ReactNode }) {
  const [discreet, setDiscreetState] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setDiscreetState(document.documentElement.dataset.discreet === '1');
  }, []);

  const setDiscreet = useCallback((on: boolean) => {
    setDiscreetState(on);
    if (on) document.documentElement.dataset.discreet = '1';
    else delete document.documentElement.dataset.discreet;
    try {
      localStorage.setItem(DISCREET_STORAGE_KEY, on ? '1' : '0');
    } catch {
      // 隐私模式下不可写，本次会话内仍生效
    }
    if (!on) {
      // 关闭时观察器压制期间的 metadata 已丢失，让 Next 重新落当前页真实标题
      document.title = APP_TITLE;
      router.refresh();
    }
  }, [router]);

  const toggle = useCallback(() => setDiscreet(!discreet), [discreet, setDiscreet]);

  // 标签页图标。**PC 独有的一处泄密面**：document.title 早就中性化了，
  // favicon 却既不在页面里、也不由 React 渲染，两条已有纪律都没盖到，
  // 而标签栏在 PC 上常驻、会被截图投屏。修法落在这里——setDiscreet 是
  // discreet 的唯一写入口，跟着这个 state 走就等于跟着那个入口走。
  useEffect(() => applyFavicon(discreet), [discreet]);

  // 桌面上的恐慌路径：浮钮只在移动端渲染（拇指区），PC 只剩键盘。
  // **开和关不对称**，理由同移动端那颗钮：取不准时偏向报警那一侧。
  //   开：400ms 内双击 Esc（最大最好找、闭眼可摸），或 ⌘⇧H
  //   关：只有 ⌘⇧H 或侧栏开关——双击 Esc 关不掉
  const lastEsc = useRef(0);
  useHotkeys(
    useMemo(
      () => ({
        'mod+shift+h': () => {
          setDiscreet(!discreet);
          return true;
        },
        escape: () => {
          // 层序最末：能走到这里，说明查看器和抽屉都没吃下这一下
          const now = Date.now();
          const quick = now - lastEsc.current <= DOUBLE_ESC_MS;
          lastEsc.current = now;
          if (!quick || discreet) return false;
          lastEsc.current = 0; // 连点三下不该开完又当成新的一次开始
          setDiscreet(true);
          return true;
        },
      }),
      [discreet, setDiscreet],
    ),
    -10,
  );

  // 低调模式期间，Next 的 metadata 会在路由切换时把真实标题写回 <title>，
  // 用观察器把任何写入压回中性标题（相等判断防止自触发循环）。
  useEffect(() => {
    if (!discreet) return;
    document.title = NEUTRAL_TITLE;
    const titleEl = document.querySelector('title');
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      if (document.title !== NEUTRAL_TITLE) document.title = NEUTRAL_TITLE;
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [discreet]);

  return (
    <DiscreetContext.Provider value={{ discreet, setDiscreet, toggle }}>
      {children}
    </DiscreetContext.Provider>
  );
}

export function useDiscreet(): DiscreetContextValue {
  const ctx = useContext(DiscreetContext);
  if (!ctx) throw new Error('useDiscreet 必须在 DiscreetProvider 内使用');
  return ctx;
}

/**
 * 页面标题：低调模式下统一显示「工作台」，否则显示真实标题。
 * 放在需要标题的页面里，不产生可见 DOM。
 */
export function DocumentTitle({ title }: { title: string }) {
  const { discreet } = useDiscreet();
  useEffect(() => {
    document.title = discreet ? NEUTRAL_TITLE : title;
    // 卸载时立即兜底，不等下一页 metadata 生效——案件标题含公司名，不能残留
    return () => {
      document.title = discreet ? NEUTRAL_TITLE : APP_TITLE;
    };
  }, [discreet, title]);
  return null;
}
