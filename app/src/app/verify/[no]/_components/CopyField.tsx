'use client';

import { useState } from 'react';
import { cn } from '@/app/_ui/cn';

/**
 * 可复制的长字符串（SHA-256 全文、订单号）。
 * 对方要拿去和自己算出的哈希比对，手抄 64 位十六进制是不现实的。
 */
export function CopyField({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] leading-6 text-ink-2">{label}</p>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // 浏览器不给复制（非安全上下文等）：长按/双击选中手动复制
              setCopied(false);
            }
          }}
          className="min-h-11 shrink-0 text-[14px] text-primary-ink hover:underline underline-offset-4"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p
        className={cn(
          'num mt-1 rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-[13px] leading-6 break-all text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}
