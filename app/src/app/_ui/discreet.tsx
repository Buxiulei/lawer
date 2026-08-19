'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { APP_TITLE, DISCREET_STORAGE_KEY, NEUTRAL_TITLE } from './bootstrap';

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
