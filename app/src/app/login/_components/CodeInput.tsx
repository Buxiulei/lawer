'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { OTP_LENGTH } from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';

/**
 * 6 位验证码输入：一位一格，自动前进/后退，支持整串粘贴。
 * 每格 48px 见方，满足触屏 ≥44px。
 */
export function CodeInput({
  value,
  onChange,
  disabled,
  invalid,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  const focusAt = (index: number) => {
    boxes.current[Math.min(Math.max(index, 0), OTP_LENGTH - 1)]?.focus();
  };

  const setDigit = (index: number, digit: string) => {
    const chars = value.padEnd(OTP_LENGTH, ' ').split('');
    chars[index] = digit || ' ';
    onChange(chars.join('').replace(/ /g, '').slice(0, OTP_LENGTH));
  };

  const handleInput = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return;
    if (digits.length > 1) {
      onChange((value.slice(0, index) + digits).slice(0, OTP_LENGTH));
      focusAt(index + digits.length);
      return;
    }
    setDigit(index, digits);
    focusAt(index + 1);
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1));
      } else if (index > 0) {
        onChange(value.slice(0, index - 1) + value.slice(index));
        focusAt(index - 1);
      }
      return;
    }
    if (e.key === 'ArrowLeft') focusAt(index - 1);
    if (e.key === 'ArrowRight') focusAt(index + 1);
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!digits) return;
    e.preventDefault();
    onChange(digits);
    focusAt(digits.length);
  };

  return (
    <div className="flex gap-2" role="group" aria-label={`${OTP_LENGTH} 位验证码`}>
      {Array.from({ length: OTP_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          value={value[i] ?? ''}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`第 ${i + 1} 位`}
          aria-invalid={invalid ? true : undefined}
          className={cn(
            'num h-12 w-full min-w-11 rounded-[10px] border bg-surface-2 text-center',
            'text-[20px] font-semibold text-ink caret-primary',
            'transition-colors duration-150 ease-out focus:border-primary focus:outline-none',
            'disabled:opacity-50',
            invalid ? 'border-danger' : 'border-line',
          )}
        />
      ))}
    </div>
  );
}
