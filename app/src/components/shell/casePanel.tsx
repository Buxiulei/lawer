'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * 「案件档案」按钮长在壳层顶栏上，抽屉的开合状态却归页面自己管。
 * 页面挂载时把自己的开抽屉函数登记进来，顶栏才渲染那个按钮；
 * 不在工作台的页面没人登记，按钮自然不出现。
 */
type Opener = () => void;

interface CasePanelContextValue {
  opener: Opener | null;
  register: (opener: Opener | null) => void;
}

const CasePanelContext = createContext<CasePanelContextValue | null>(null);

export function CasePanelProvider({ children }: { children: ReactNode }) {
  const [opener, setOpener] = useState<Opener | null>(null);
  // setState 会把函数当成 updater，登记时统一包一层
  const register = useCallback((next: Opener | null) => setOpener(() => next), []);
  const value = useMemo(() => ({ opener, register }), [opener, register]);
  return <CasePanelContext.Provider value={value}>{children}</CasePanelContext.Provider>;
}

/** 顶栏用：拿到当前页登记的开抽屉函数，没有就不渲染按钮 */
export function useCasePanelOpener(): Opener | null {
  return useContext(CasePanelContext)?.opener ?? null;
}

/** 页面用：把自己的开抽屉函数登记到壳层，卸载时撤回 */
export function useRegisterCasePanel(opener: Opener | null): void {
  const ctx = useContext(CasePanelContext);
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    register(opener);
    return () => register(null);
  }, [register, opener]);
}
