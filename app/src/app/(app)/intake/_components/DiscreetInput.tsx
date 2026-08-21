'use client';

import { useId, useState, type InputHTMLAttributes } from 'react';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { Field } from '@/components/shadcn/field';
import { Input } from '@/components/shadcn/input';

/**
 * 敏感输入框（月薪、公司名）：低调模式下未聚焦时打码，聚焦即恢复。
 * 不能直接套 <Sensitive>——那个组件会把内容变成按钮，输入框就没法打字了。
 */
export function DiscreetInput({
  label,
  hint,
  className,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const { discreet } = useDiscreet();
  const [focused, setFocused] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const masked = discreet && !focused;

  return (
    <Field label={label} hint={hint} htmlFor={inputId}>
      <Input
        id={inputId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cn(masked && 'discreet-blur', className)}
        {...rest}
      />
    </Field>
  );
}
