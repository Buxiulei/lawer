'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * 受控弹层的焦点还原。
 *
 * Radix 关闭时会把焦点交回 Trigger，但我们这几个弹层是外面的按钮控 open、
 * 树里没有 Trigger，Radix 就不知道该还给谁，焦点会掉回 body——键盘用户丢位置。
 * 开之前记一下焦点停在哪儿，关的时候在 onCloseAutoFocus 里送回去。
 *
 * 用法：const onCloseAutoFocus = useFocusRestore(open) 挂到 Content 上。
 */
export function useFocusRestore(open: boolean): (e: Event) => void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) restoreTo.current = document.activeElement as HTMLElement | null;
  }, [open]);

  return useCallback((e: Event) => {
    // 元素已经从文档里没了（比如那一行被删掉了）就别抢，让 Radix 走默认
    if (!restoreTo.current?.isConnected) return;
    e.preventDefault();
    restoreTo.current.focus();
  }, []);
}
