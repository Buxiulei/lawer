'use client';

import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils';
import { useSheetDrag } from './use-sheet-drag';

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
        // 时长走 token，不写现场数字（动效 v1 原则 4）
        'data-[state=open]:animate-[fade-in_var(--mo-route)_var(--ease-out)]',
        'data-[state=closed]:animate-[fade-out_var(--mo-exit)_var(--ease-in)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 移动端从底部升起、PC（≥1024px）从右侧滑入——与 DESIGN.md 的抽屉规则一致，
 * 250ms、不做弹跳。
 *
 * 【工单 B1：退场改「落下」，不再淡出】
 * 升起来的东西淡出会读成「它消失了」而不是「它收回去了」。
 * 收回去才对——再点一下它还会从同一个地方升起来。落下 200ms（= 升起 250 × 0.8）。
 *
 * 【工单 B2：<md 底部档可以下拉关闭】
 * 手势只是拇指的捷径：`SheetClose` 与 Esc 始终在，键盘和读屏一条也没少。
 * 关闭走一个藏起来的 `SheetPrimitive.Close`——**必须让 Radix 的状态机来关**，
 * 自己 animate 完再卸载就会和它的 Presence 退场撞成两套时序。
 */
function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content>) {
  // 用 state 而不是 ref 接这个节点：抽屉关着时 Radix 不渲染 Content，
  // ref 的赋值又不触发重渲染，拖拽 hook 的 effect 会永远只看见 null（且不报错）。
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const requestClose = React.useCallback(() => closeRef.current?.click(), []);
  useSheetDrag(content, requestClose);

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={setContent}
        data-slot="sheet-content"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-[16px] bg-card outline-none',
          // 批 1：换边断点从 lg 提前到 md——规格把 768–1279 定成独立的平板档，
          // 手机是底部升起的抽屉，平板起是侧边推入。全站抽屉共用这条规则。
          'md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[420px] md:rounded-none md:rounded-l-[16px] md:border-l md:border-border',
          'data-[state=open]:animate-[sheet-up_var(--mo-sheet)_var(--ease-out)]',
          'lg:data-[state=open]:animate-[sheet-right_var(--mo-sheet)_var(--ease-out)]',
          'data-[state=closed]:animate-[sheet-down_var(--mo-layer)_var(--ease-in)]',
          'lg:data-[state=closed]:animate-[sheet-right-out_var(--mo-layer)_var(--ease-in)]',
          className,
        )}
        {...props}
      >
        {children}
        {/* 手势关闭的出口。display:none 的按钮 .click() 照样派发事件，
            又不会多一个 Tab 停靠点。 */}
        <SheetPrimitive.Close ref={closeRef} hidden aria-hidden tabIndex={-1} />
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

/**
 * 抽屉头。**整条 header 都是下拉关闭的热区**，顶部那根 36×4 的条只是提示——
 * 只让 4px 高的条可拖，拇指根本瞄不准。
 * `touch-none` 只加在 <md 的 header 上：正文区要保持 `pan-y` 才能滚。
 */
function SheetHeader({ className, children, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="sheet-header"
      className={cn(
        'relative flex min-h-14 shrink-0 touch-none items-center justify-between gap-3 border-b border-border px-4 md:touch-auto',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="absolute top-2 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-border md:hidden"
      />
      {children}
    </header>
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
