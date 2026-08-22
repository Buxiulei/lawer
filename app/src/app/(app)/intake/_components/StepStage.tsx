'use client';

import { INTAKE_STAGES } from '@/app/_mock/intake-evidence';
import { ChoiceCards } from './ChoiceCard';
import type { IntakeDraft } from './draft';

export function StepStage({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  return (
    // ChoiceCards 不透传多余 props，包一层原生元素承载 data-veil
    <div data-veil="">
      <ChoiceCards
        ariaLabel="现在处于哪一步"
        options={INTAKE_STAGES}
        value={draft.stage}
        onChange={(stage) => patch({ stage })}
      />
    </div>
  );
}
