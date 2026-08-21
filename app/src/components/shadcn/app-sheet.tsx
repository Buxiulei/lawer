'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet';
import { XIcon } from './icons';

/**
 * 抽屉（shadcn Sheet 版）：props 与手写版 @/components/ui/Sheet 逐字一致，
 * 转体系的页面换 import 即可。焦点陷阱、Esc 关闭、滚动锁定由 Radix 接管。
 */
export function AppSheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  /**
   * 开合由外面的按钮控制，没有 SheetTrigger，Radix 就不知道关掉之后该把焦点还给谁，
   * 会掉回 body。自己记一下开之前停在哪儿，关的时候送回去。
   */
  const restoreTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) restoreTo.current = document.activeElement as HTMLElement | null;
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          if (!restoreTo.current?.isConnected) return;
          e.preventDefault();
          restoreTo.current.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetClose
            aria-label="关闭"
            className="-mr-2 flex size-11 items-center justify-center rounded-[10px] text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted"
          >
            <XIcon />
          </SheetClose>
        </SheetHeader>
        <SheetBody>{children}</SheetBody>
        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
