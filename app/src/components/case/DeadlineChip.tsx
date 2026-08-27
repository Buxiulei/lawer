import { Badge } from '@/components/shadcn/badge';
import { formatCountdown, formatDate, daysUntil } from '@/app/_ui/format';

/**
 * 倒计时徽标：≤3 天 amber 底，>3 天灰底。逾期也用 amber，不用红、不闪烁。
 */
export function DeadlineChip({
  dueAt,
  showDate = false,
  now,
}: {
  dueAt: string;
  showDate?: boolean;
  now?: Date;
}) {
  const days = daysUntil(dueAt, now);
  const urgent = days <= 3;
  return (
    <Badge tone={urgent ? 'amber' : 'neutral'} className="num">
      {showDate ? `${formatDate(dueAt)} · ` : ''}
      {formatCountdown(dueAt, now)}
    </Badge>
  );
}
