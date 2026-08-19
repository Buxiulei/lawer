'use client';

import { INTAKE_STAGES } from '@/app/_mock/intake-evidence';
import { ChoiceCard } from './ChoiceCard';
import type { IntakeDraft } from './draft';

export function StepStage({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  return (
    <div role="radiogroup" aria-label="现在处于哪一步" className="flex flex-col gap-2.5">
      {INTAKE_STAGES.map((s) => (
        <ChoiceCard
          key={s.value}
          title={s.value}
          plain={s.plain}
          selected={draft.stage === s.value}
          onSelect={() => patch({ stage: s.value })}
        />
      ))}
    </div>
  );
}
