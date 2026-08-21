'use client';

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './utils';
import { Input } from './input';
import { Label } from './label';
import { Textarea } from './textarea';

/**
 * 带标签/提示/错误的表单行。API 沿用被它取代的手写版 ui/Field，
 * 转体系的页面换 import 即可。
 */
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
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-1 text-amber-ink">必填</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-[13px] leading-5 text-danger-ink">{error}</p>
      ) : hint ? (
        <p className="text-[13px] leading-5 text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function InputField({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: InputFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={rest.required}
      htmlFor={inputId}
    >
      <Input
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(className)}
        {...rest}
      />
    </Field>
  );
}

export interface TextareaFieldProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextareaField({
  label,
  hint,
  error,
  className,
  id,
  rows = 4,
  ...rest
}: TextareaFieldProps) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={rest.required}
      htmlFor={areaId}
    >
      <Textarea
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(className)}
        {...rest}
      />
    </Field>
  );
}
