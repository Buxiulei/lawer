'use client';

import { COMPANY_DOC_QUESTIONS, HAS_DOC_ANSWERS } from '@/app/_mock/intake-evidence';
import { Textarea } from '@/components/ui/Field';
import { ChoiceRow } from './ChoiceCard';
import type { IntakeDraft } from './draft';

export function StepCompanyDocs({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  const hasAny = COMPANY_DOC_QUESTIONS.some((q) => draft[q.key] === '有');

  return (
    <div className="flex flex-col gap-5">
      {COMPANY_DOC_QUESTIONS.map((q) => (
        <div key={q.key} className="flex flex-col gap-2">
          <p className="text-[15px] leading-7 font-medium text-ink">{q.label}</p>
          <p className="text-[14px] leading-6 text-ink-2">{q.plain}</p>
          <ChoiceRow
            ariaLabel={q.label}
            options={HAS_DOC_ANSWERS}
            value={draft[q.key]}
            onChange={(v) => patch({ [q.key]: v } as Partial<IntakeDraft>)}
          />
        </div>
      ))}

      {hasAny && (
        <p className="rounded-[10px] border border-primary/30 bg-primary-wash px-3.5 py-3 text-[15px] leading-7 text-primary-ink">
          有文件就先留着，不用现在上传。建完档进工作台后，到「文件解读」把原件拍照传上去，
          会逐条标出对你不利的表述，并给出签、不签还是要求改的结论。
        </p>
      )}

      <Textarea
        label="公司口头是怎么说的"
        rows={4}
        value={draft.companyWording}
        onChange={(e) => patch({ companyWording: e.target.value })}
        placeholder="例如：说是业务调整，给 N+1，当天签当天走；或者说绩效不合格。"
        hint="公司给的理由决定了后面能主张 N 还是 2N，原话比转述有用，尽量按记得的说法写。"
      />
    </div>
  );
}
