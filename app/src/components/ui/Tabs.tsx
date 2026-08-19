'use client';

import { cn } from '@/app/_ui/cn';

export interface TabItem {
  key: string;
  label: string;
  /** 右上角计数，如证据条数 */
  count?: number;
}

/**
 * 受控 Tabs。当前态用 primary 色下划线 + 字重，不靠底色块。
 */
export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 border-b border-line overflow-x-auto', className)}
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative min-h-11 shrink-0 px-3 text-[15px] transition-colors duration-150 ease-out',
              active ? 'font-semibold text-primary-ink' : 'text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
            {typeof item.count === 'number' && (
              <span className="num ml-1 text-[13px] text-ink-2">{item.count}</span>
            )}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
