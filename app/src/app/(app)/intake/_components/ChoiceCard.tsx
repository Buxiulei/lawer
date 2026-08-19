'use client';

import { cn } from '@/app/_ui/cn';

/**
 * 选项卡片：标题 + 一句白话。整卡可点，高度远超 44px，地铁上单手也点得中。
 * 单选用 radio 语义，多选用 checkbox 语义——读屏器要能听出区别。
 */
export function ChoiceCard({
  title,
  plain,
  selected,
  multiple = false,
  onSelect,
}: {
  title: string;
  plain?: string;
  selected: boolean;
  multiple?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={multiple ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-[12px] border p-3.5 text-left',
        'transition-colors duration-150 ease-out',
        selected
          ? 'border-primary bg-primary-wash'
          : 'border-line bg-surface hover:bg-surface-2',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center border',
          multiple ? 'rounded-[6px]' : 'rounded-full',
          selected ? 'border-primary bg-primary text-white' : 'border-line bg-surface',
        )}
        aria-hidden
      >
        {selected && (
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M3.5 8.4l3 3 6-6.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-[16px] leading-7 font-semibold',
            selected ? 'text-primary-ink' : 'text-ink',
          )}
        >
          {title}
        </span>
        {plain && (
          <span className="mt-0.5 block text-[14px] leading-6 text-ink-2">{plain}</span>
        )}
      </span>
    </button>
  );
}

/** 三选一这类短选项用的紧凑分段控件，高度仍保持 44px 以上。 */
export function ChoiceRow({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex gap-2">
      {options.map((opt) => {
        const selected = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt)}
            className={cn(
              'min-h-11 flex-1 rounded-[10px] border px-3 text-[15px] font-medium',
              'transition-colors duration-150 ease-out',
              selected
                ? 'border-primary bg-primary-wash text-primary-ink'
                : 'border-line bg-surface text-ink-2 hover:bg-surface-2',
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
