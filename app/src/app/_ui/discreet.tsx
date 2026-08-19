'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { DISCREET_STORAGE_KEY, NEUTRAL_TITLE } from './bootstrap';

interface DiscreetContextValue {
  discreet: boolean;
  setDiscreet: (on: boolean) => void;
  toggle: () => void;
}

const DiscreetContext = createContext<DiscreetContextValue | null>(null);

export function DiscreetProvider({ children }: { children: ReactNode }) {
  const [discreet, setDiscreetState] = useState(false);

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
  }, []);

  const toggle = useCallback(() => setDiscreet(!discreet), [discreet, setDiscreet]);

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
  }, [discreet, title]);
  return null;
}
