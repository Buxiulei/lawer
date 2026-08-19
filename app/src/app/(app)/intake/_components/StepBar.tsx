import { cn } from '@/app/_ui/cn';

/**
 * 进度条：一屏一件事的前提是随时知道自己在哪、还剩几步。
 * 只显示进度，不做点击跳转——回退走底部的「上一步」，方向唯一。
 */
export function StepBar({
  current,
  total,
  title,
}: {
  current: number;
  total: number;
  title: string;
}) {
  return (
    <div className="pt-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[20px] leading-8 font-semibold text-ink">{title}</h2>
        <span className="num shrink-0 text-[14px] text-ink-2">
          第 {current + 1} / {total} 步
        </span>
      </div>
      <div className="mt-2.5 flex gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-150 ease-out',
              i < current ? 'bg-primary/45' : i === current ? 'bg-primary' : 'bg-line',
            )}
          />
        ))}
      </div>
    </div>
  );
}
