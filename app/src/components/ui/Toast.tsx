'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { NEUTRAL_NOTICE } from '@/app/_ui/bootstrap';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';

type ToastTone = 'neutral' | 'success' | 'amber';

interface ToastItem {
  id: number;
  message: string;
  discreetMessage?: string;
  tone: ToastTone;
}

/**
 * 低调模式下 message 会被 discreetMessage 顶替（缺省用 NEUTRAL_NOTICE）。
 * 凡是带公司名、金额、案件字样的提示，调用方必须给一个中性的 discreetMessage。
 */
export type ToastPush = (
  message: string,
  tone?: ToastTone,
  discreetMessage?: string,
) => void;

const ToastContext = createContext<ToastPush | null>(null);

const TONES: Record<ToastTone, string> = {
  neutral: 'bg-ink text-bg',
  success: 'bg-success text-white',
  amber: 'bg-amber text-white',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const { discreet } = useDiscreet();

  const push: ToastPush = useCallback(
    (message, tone = 'neutral', discreetMessage) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message, discreetMessage, tone }]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, 2600);
    },
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom)+12px)] z-70 flex flex-col items-center gap-2 px-4 lg:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'max-w-[92vw] rounded-[10px] px-4 py-2.5 text-[15px] shadow-soft',
              TONES[t.tone],
            )}
            style={{ animation: 'fade-in 150ms ease-out' }}
          >
            {discreet ? (t.discreetMessage ?? NEUTRAL_NOTICE) : t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast 必须在 ToastProvider 内使用');
  return push;
}
