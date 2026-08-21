'use client';

import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';
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
    <RadioGroup
      aria-label="证据类别"
      value={value}
      onValueChange={(next) => onChange(next as EvidenceCategory)}
    >
      {categories.map((c) => (
        <RadioGroupItem key={c} value={c}>
          {c}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}
