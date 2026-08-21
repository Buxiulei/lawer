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
    <ChoiceCards
      ariaLabel="现在处于哪一步"
      options={INTAKE_STAGES}
      value={draft.stage}
      onChange={(stage) => patch({ stage })}
    />
  );
}
