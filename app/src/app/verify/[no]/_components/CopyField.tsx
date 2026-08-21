'use client';

import { useState } from 'react';
import { Button } from '@/components/shadcn/button';

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
        <Button
          variant="ghost"
          size="sm"
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
          className="px-2 text-[14px]"
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <p className="num mt-1 rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-[13px] leading-6 break-all text-ink">
        {value}
      </p>
    </div>
  );
}
