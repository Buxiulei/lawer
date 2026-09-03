'use client';

import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { useFocusRestore } from './use-focus-restore';

/**
 * 二次确认（shadcn AlertDialog 版）：props 沿用被它取代的手写版 ui/ConfirmDialog，
 * 逐字一致，转体系的页面换 import 即可。
 *
 * 规矩不变：凡"会被公司看到 / 不可逆"的操作必须弹，
 * confirmLabel 必须写明后果（如「确认发送给公司」），不许写「确定」。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '再想想',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const onCloseAutoFocus = useFocusRestore(open);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* 主按钮写在前面：footer 窄屏是 flex-col（没有 reverse），上下顺序就是
              DOM 顺序，主按钮得在上。电脑端靠 sm:order-* 把次按钮摆回左边。 */}
          {/* tone 走 variant 而不是 className：className 排在 cn() 最后，
              buttonVariants 里 size md 的 text-[16px] 会把 BUTTON_LAYOUT 的
              clamp 顶掉，主按钮不缩、次按钮缩，360/320 上两钮字号不一。 */}
          <AlertDialogAction onClick={onConfirm} variant={tone}>
            {confirmLabel}
          </AlertDialogAction>
          <AlertDialogCancel onClick={onCancel}>{cancelLabel}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
