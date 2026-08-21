'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/app/_ui/cn';

const CONTROL_BASE =
  'w-full rounded-[10px] bg-surface-2 border border-line px-3 text-[16px] text-ink ' +
  'placeholder:text-ink-2/70 transition-colors duration-150 ease-out ' +
  'focus:border-primary focus:outline-none disabled:opacity-50';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[14px] font-medium text-ink">
        {label}
        {required && <span className="ml-1 text-amber-ink">必填</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] leading-5 text-danger-ink">{error}</p>
      ) : hint ? (
        <p className="text-[13px] leading-5 text-ink-2">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} htmlFor={inputId}>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL_BASE, 'h-12', error && 'border-danger', className)}
        {...rest}
      />
    </Field>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Textarea({ label, hint, error, className, id, rows = 4, ...rest }: TextareaProps) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} htmlFor={areaId}>
      <textarea
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL_BASE, 'py-2.5 leading-7 resize-y', error && 'border-danger', className)}
        {...rest}
      />
    </Field>
  );
}
