'use client';

import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/35',
        'data-[state=open]:animate-[fade-in_150ms_ease-out] data-[state=closed]:animate-[fade-out_150ms_ease-out]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 移动端从底部升起、PC（≥1024px）从右侧滑入——与 DESIGN.md 的抽屉规则一致，
 * 250ms、不做弹跳。退场统一淡出，避免两个方向的收场动画互相打架。
 */
function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-[16px] bg-card outline-none',
          'lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-[420px] lg:rounded-none lg:rounded-l-[16px] lg:border-l lg:border-border',
          'data-[state=open]:animate-[sheet-up_250ms_ease-out] lg:data-[state=open]:animate-[sheet-right_250ms_ease-out]',
          'data-[state=closed]:animate-[fade-out_150ms_ease-out]',
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="sheet-header"
      className={cn(
        'flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4',
        className,
      )}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn('flex-1 overflow-y-auto px-4 py-4', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'footer'>) {
  return (
    <footer
      data-slot="sheet-footer"
      className={cn(
        'shrink-0 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-[16px] font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-[14px] leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
