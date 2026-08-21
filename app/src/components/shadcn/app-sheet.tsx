'use client';

import type { ReactNode } from 'react';
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
import { useFocusRestore } from './use-focus-restore';

/**
 * 抽屉（shadcn Sheet 版）：props 沿用被它取代的手写版 ui/Sheet，逐字一致，
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
  const onCloseAutoFocus = useFocusRestore(open);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
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
