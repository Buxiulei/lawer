'use client';

import { useState } from 'react';
import type { LawRef } from '@/app/_mock/types';

/**
 * 法条卡：条号 + 一句话结论；点开显示逐字原文（surface-2 引用块 + 4px primary 左边线）。
 * 原文必须逐字，不做改写——用户要拿去当依据。
 */
export function LawRefCard({ law }: { law: LawRef }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-[12px] border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <span className="mt-0.5 shrink-0 text-primary" aria-hidden>
          <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M5 3h7l3 3v11H5z" strokeLinejoin="round" />
            <path d="M12 3v3h3M7.5 10h5M7.5 13h3.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-ink">{law.cite}</span>
          <span className="mt-0.5 block text-[15px] leading-7 text-ink-2">
            {law.conclusion}
          </span>
          <span className="mt-1 block text-[14px] text-primary-ink">
            {open ? '收起原文' : '看逐字原文'}
          </span>
        </span>
      </button>

      {open && (
        <blockquote className="mx-3.5 mb-3.5 border-l-4 border-primary bg-surface-2 px-3.5 py-3 text-[15px] leading-7 text-ink">
          {law.fullText}
        </blockquote>
      )}
    </div>
  );
}
