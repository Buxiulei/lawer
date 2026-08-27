import { Card } from '@/components/shadcn/card';
import { cn } from '@/components/shadcn/utils';
import type { CompanyDoc } from '@/app/_mock/types';
import { ADVICE_SUMMARY } from './badges';
import { SensitiveText } from './SensitiveText';

type Advice = CompanyDoc['advice'];

/**
 * 签 / 不签 / 改签 / 待定 四态大卡：结论要在 3 秒内被看到。
 * 「不签」用 danger 底 + 左边线，与正文里被标红的条款是同一套视觉语言；
 * 其余三态不占用红色。
 */
const SKIN: Record<Advice, { box: string; word: string; line: string }> = {
  签: {
    box: 'bg-success-wash border-transparent',
    word: 'text-success',
    line: 'bg-success',
  },
  不签: {
    box: 'bg-danger-wash border-transparent',
    word: 'text-danger',
    line: 'bg-danger',
  },
  改签: {
    box: 'bg-amber-wash border-transparent',
    word: 'text-amber',
    line: 'bg-amber',
  },
  待定: {
    box: 'bg-surface-2 border-transparent',
    word: 'text-ink',
    line: 'bg-ink-2',
  },
};

export function AdviceCard({
  advice,
  detail,
  revisePoints,
}: {
  advice: Advice;
  detail: string;
  revisePoints?: string[];
}) {
  const skin = SKIN[advice];

  return (
    <Card
      aria-label={`签署建议：${advice}`}
      className={cn('relative overflow-hidden pl-4 shadow-none', skin.box)}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', skin.line)} aria-hidden />

      <div data-veil="" className="px-4 py-4">
        <p className="fs-xs font-medium text-ink-2">签署建议</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <strong className={cn('fs-xl font-semibold', skin.word)}>
            {advice}
          </strong>
          <span className="fs-m text-ink">{ADVICE_SUMMARY[advice]}</span>
        </div>

        <p className="prose-measure mt-3 fs-m text-ink">
          <SensitiveText text={detail} />
        </p>

        {revisePoints && revisePoints.length > 0 && (
          <div className="mt-4 rounded-[10px] bg-card p-3.5">
            <h3 className="fs-m font-semibold text-ink">逐条改成这样再签</h3>
            <ol className="mt-2 flex flex-col gap-2">
              {revisePoints.map((point, i) => (
                <li key={i} className="flex gap-2.5 fs-m text-ink-2">
                  <span className="num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 fs-xs font-semibold text-ink">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <SensitiveText text={point} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Card>
  );
}
