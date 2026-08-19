'use client';

import { cn } from '@/app/_ui/cn';

/** 开关：外层 44px 触区，里面才是 48×28 的轨道。 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex size-11 shrink-0 items-center justify-center disabled:opacity-45"
    >
      <span
        className={cn(
          'relative block h-7 w-12 rounded-full transition-colors duration-150 ease-out',
          checked ? 'bg-primary' : 'bg-line',
        )}
      >
        <span
          className={cn(
            'absolute top-1 size-5 rounded-full bg-surface shadow-soft transition-[left] duration-150 ease-out',
            checked ? 'left-6' : 'left-1',
          )}
        />
      </span>
    </button>
  );
}
