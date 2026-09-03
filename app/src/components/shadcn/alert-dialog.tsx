'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from './utils';
import { buttonVariants } from './button';

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'fixed inset-0 z-60 bg-black/40',
        'data-[state=open]:animate-[fade-in_150ms_ease-out] data-[state=closed]:animate-[fade-out_150ms_ease-out]',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-60 w-[calc(100%-2rem)] max-w-[420px] -translate-x-1/2',
          'sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2',
          'rounded-[12px] border border-border bg-card p-5 shadow-soft outline-none',
          'data-[state=open]:animate-[fade-in_150ms_ease-out] data-[state=closed]:animate-[fade-out_150ms_ease-out]',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        'mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 弹窗两个按钮的共同排布。窄屏各自全宽上下排，电脑端收回内容宽、并排在右。
 *
 * 【字号为什么带 clamp】按钮是 `whitespace-nowrap`（buttonVariants 里定的），
 * 文案超长不会换行、只会**横着溢出按钮**——在电脑上看不出来，手机上才露。
 * 两条策略里选了「自动缩字号」而不是「截断」：确认按钮的文案是后果本身
 * （「确认已发送给公司」），截成「确认已发送…」等于把后果藏了。
 * clamp 按视口宽收字号（393→16px、360→14.8px、320→13.1px），电脑端固定回 16px。
 * 另一半在 `__tests__/confirm-dialog-buttons.test.tsx`：文案字面量上限 12 个字，
 * 12 字 @16px + 左右内边距 = 232px，比 393 屏下按钮内宽 321px 还窄 89px。
 */
const BUTTON_LAYOUT = 'w-full text-[clamp(14px,4.1vw,16px)] sm:w-auto sm:text-[16px]';

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-[17px] leading-7 font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-[15px] leading-7 text-muted-foreground', className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(
        buttonVariants({ variant: 'primary' }),
        BUTTON_LAYOUT,
        'sm:order-2 sm:min-w-28',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(
        buttonVariants({ variant: 'outline' }),
        BUTTON_LAYOUT,
        'sm:order-1 sm:min-w-24',
        className,
      )}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
