'use client';

import { cn } from '@/app/_ui/cn';
import type { EvidenceCategory } from '@/app/_mock/types';

/** 类别单选：枚举照 spec §7 evidence.category，顺序固定，用户按记忆位置点。 */
export function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: readonly EvidenceCategory[];
  value: EvidenceCategory;
  onChange: (next: EvidenceCategory) => void;
}) {
  return (
    <div role="radiogroup" aria-label="证据类别" className="flex flex-wrap gap-2">
      {categories.map((c) => {
        const selected = c === value;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(c)}
            className={cn(
              'min-h-11 rounded-[10px] border px-3.5 text-[15px] font-medium',
              'transition-colors duration-150 ease-out',
              selected
                ? 'border-primary bg-primary-wash text-primary-ink'
                : 'border-line bg-surface text-ink-2 hover:bg-surface-2',
            )}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}
