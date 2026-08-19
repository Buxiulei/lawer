'use client';

import { useEffect, type ReactNode } from 'react';
import { Button } from './Button';

/**
 * 二次确认：凡"会被公司看到 / 不可逆"的操作必须弹。
 * confirmLabel 必须写明后果（如「确认发送给公司」），不要写「确定」。
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="absolute inset-0 bg-black/40"
        style={{ animation: 'fade-in 150ms ease-out' }}
        onClick={onCancel}
        aria-hidden
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[420px] rounded-[12px] border border-line bg-surface p-5 shadow-soft"
        style={{ animation: 'fade-in 150ms ease-out' }}
      >
        <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
        <div className="mt-2 text-[15px] leading-7 text-ink-2">{description}</div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} className="sm:min-w-24">
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
