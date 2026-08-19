'use client';

import { useEffect, type ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';

/**
 * 移动端底部弹层 / PC（≥1024px）右侧抽屉。250ms，不做弹跳。
 */
export function Sheet({
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end lg:items-stretch lg:justify-end">
      <div
        className="absolute inset-0 bg-black/35"
        style={{ animation: 'fade-in 150ms ease-out' }}
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative flex max-h-[85vh] w-full flex-col rounded-t-[16px] bg-surface',
          'lg:h-full lg:max-h-none lg:w-[420px] lg:rounded-none lg:rounded-l-[16px] lg:border-l lg:border-line',
        )}
        style={{ animation: 'sheet-up 250ms ease-out' }}
      >
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
          <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="-mr-2 flex size-11 items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
