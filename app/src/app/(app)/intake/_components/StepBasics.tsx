'use client';

import { CONTRACT_COUNTS, serviceYearsBetween } from '@/app/_mock/intake-evidence';
import { Input } from '@/components/ui/Field';
import { ChoiceCard } from './ChoiceCard';
import { DiscreetInput } from './DiscreetInput';
import type { IntakeDraft } from './draft';

export function StepBasics({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  const years = draft.hiredOn ? serviceYearsBetween(draft.hiredOn, new Date()) : null;

  return (
    <div className="flex flex-col gap-5">
      <Input
        label="入职时间"
        type="date"
        value={draft.hiredOn}
        max="2100-12-31"
        onChange={(e) => patch({ hiredOn: e.target.value })}
        hint={
          years !== null && years > 0
            ? `按今天算，工龄折算 ${years} 年（满半年算一年，不满半年算半年）。`
            : '合同上写的入职日期。记不清就填大概，后面上传合同会自动核对。'
        }
      />

      <DiscreetInput
        label="月工资（元）"
        type="text"
        inputMode="decimal"
        value={draft.monthlyWage}
        placeholder="例如 25000"
        onChange={(e) => patch({ monthlyWage: e.target.value })}
        hint="填离职前 12 个月的平均实发工资，含奖金和补贴。低调模式下这一栏会自动打码。"
      />

      <Input
        label="岗位"
        value={draft.position}
        placeholder="例如 后端工程师"
        onChange={(e) => patch({ position: e.target.value })}
        hint="写合同上的岗位名称，和实际做的事不一致也没关系，后面可以说明。"
      />

      <DiscreetInput
        label="公司名称"
        value={draft.companyName}
        placeholder="劳动合同上盖章的那个公司"
        onChange={(e) => patch({ companyName: e.target.value })}
        hint="以合同签章为准。发工资的公司和签合同的公司不是同一个时，两个都记下来。"
      />

      <div className="flex flex-col gap-2.5">
        <p className="text-[14px] font-medium text-ink">劳动合同签了几次</p>
        <div role="radiogroup" aria-label="劳动合同签了几次" className="flex flex-col gap-2">
          {CONTRACT_COUNTS.map((c) => (
            <ChoiceCard
              key={c}
              title={c}
              selected={draft.contractCount === c}
              onSelect={() => patch({ contractCount: c })}
            />
          ))}
        </div>
        <p className="text-[13px] leading-6 text-ink-2">
          续签两次以上、或者没签书面合同，都会直接影响你能主张什么，所以要单独问一句。
        </p>
      </div>
    </div>
  );
}
