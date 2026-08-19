import { cn } from '@/app/_ui/cn';
import { formatFen } from '@/app/_ui/format';

/**
 * 金额展示：分 → 元，tabular-nums + 600 字重 + primary-ink。
 * 金额属于敏感内容，调用方按需再包 <Sensitive>。
 */
export function AmountText({
  fen,
  size = 'md',
  className,
}: {
  fen: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'num font-semibold text-primary-ink',
        size === 'sm' && 'text-[15px]',
        size === 'md' && 'text-[17px]',
        size === 'lg' && 'text-[26px] leading-9',
        className,
      )}
    >
      <span className="mr-0.5 text-[0.8em] font-medium">¥</span>
      {formatFen(fen)}
    </span>
  );
}
