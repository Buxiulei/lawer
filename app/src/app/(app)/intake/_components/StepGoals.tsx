'use client';

import { GOAL_OPTIONS } from '@/app/_mock/intake-evidence';
import { TextareaField } from '@/components/shadcn/field';
import { ChoiceChecks } from './ChoiceCard';
import type { IntakeDraft } from './draft';

export function StepGoals({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  const toggle = (value: string) =>
    patch({
      goals: draft.goals.includes(value)
        ? draft.goals.filter((g) => g !== value)
        : [...draft.goals, value],
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <p className="text-[15px] leading-7 text-ink-2">
          能多选。现在选不准也没关系，档案建好后随时改。
        </p>
        <ChoiceChecks
          ariaLabel="你想要什么"
          options={GOAL_OPTIONS}
          values={draft.goals}
          onToggle={toggle}
        />
      </div>

      <TextareaField
        label="你的底线是什么"
        rows={4}
        value={draft.bottomLine}
        onChange={(e) => patch({ bottomLine: e.target.value })}
        placeholder="例如：低于 2N 不签；不接受写成个人原因离职；必须一次性付清。"
        hint="写下来的底线会一直挂在档案首页。谈判到中途容易被带着走，这行字是给那时候的你看的。"
      />
    </div>
  );
}
