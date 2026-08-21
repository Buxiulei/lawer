'use client';

import { cn } from '@/app/_ui/cn';
import { Checkbox } from '@/components/shadcn/checkbox';
import { CheckIcon } from '@/components/shadcn/icons';
import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';

export interface Choice<T extends string = string> {
  value: T;
  plain?: string;
}

/** 选项卡片共用的外形：整卡可点，高度远超 44px，地铁上单手也点得中。 */
const CARD =
  'flex w-full items-start gap-3 rounded-[12px] border p-3.5 text-left ' +
  'transition-colors duration-150 ease-out';

/**
 * 单选卡片组：卡片观感照旧，选中态由 Radix RadioGroup 托管。
 * 换成 RadioGroup 是为了 roving tabindex——五张卡在 Tab 序里只占一个停靠点，
 * 组内用方向键走；原来每张卡各占一个停靠点，键盘用户要按五下才能过去。
 */
export function ChoiceCards<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: readonly Choice<T>[];
  value: T | '';
  onChange: (next: T) => void;
}) {
  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="flex-col flex-nowrap gap-2.5"
    >
      {options.map((o) => (
        <RadioGroupItem
          key={o.value}
          value={o.value}
          className={cn(CARD, 'group font-normal')}
        >
          <span
            className={cn(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card',
              'group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground',
            )}
            aria-hidden
          >
            <CheckIcon className="size-3.5 opacity-0 group-data-[state=checked]:opacity-100" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] leading-7 font-semibold text-ink group-data-[state=checked]:text-primary-ink">
              {o.value}
            </span>
            {o.plain && (
              <span className="mt-0.5 block text-[14px] leading-6 text-ink-2">{o.plain}</span>
            )}
          </span>
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

/**
 * 多选卡片组。整卡是个 <label>，点文字由浏览器转发给里面的 Checkbox——
 * button 是 labelable 元素，label 会自动认它当被标注控件，
 * 卡片这一层再挂 onClick 反而会把状态来回切两次。
 */
export function ChoiceChecks({
  ariaLabel,
  options,
  values,
  onToggle,
}: {
  ariaLabel: string;
  options: readonly Choice[];
  values: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-col gap-2">
      {options.map((o) => {
        const checked = values.includes(o.value);
        return (
          <label
            key={o.value}
            className={cn(
              CARD,
              'cursor-pointer',
              checked ? 'border-primary bg-primary-wash' : 'border-border bg-card hover:bg-muted',
            )}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={() => onToggle(o.value)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block text-[16px] leading-7 font-semibold',
                  checked ? 'text-primary-ink' : 'text-ink',
                )}
              >
                {o.value}
              </span>
              {o.plain && (
                <span className="mt-0.5 block text-[14px] leading-6 text-ink-2">{o.plain}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** 三选一这类短选项用的紧凑分段控件，高度仍保持 44px 以上。 */
export function ChoiceRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly T[];
  value: T | '';
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="flex-nowrap"
    >
      {options.map((opt) => (
        <RadioGroupItem key={opt} value={opt} className="flex-1">
          {opt}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}
