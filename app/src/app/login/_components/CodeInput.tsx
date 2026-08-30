'use client';

import {
  useEffect,
  useRef,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { OTP_LENGTH } from '@/app/_mock/authpay';
import { Input } from '@/components/shadcn/input';

/** 一次输入事件算出来的新整串，以及下一格该聚焦到哪。 */
export interface CodeEdit {
  value: string;
  focus: number;
}

/**
 * 一格的输入 → 新的整串。raw 里一个数字都没有就回 null（什么都不做）。
 *
 * 抽出来是因为**这个错位只有连打多格之后才现形**：单看每一次事件的结果都说得通，
 * 要跑完「先 000000、再点第 1 格逐格重打 135790」整条序列才看得见末位被吞。
 *
 * `pasted` 只认 `inputType === 'insertFromPaste'`。原来是按"raw 有几位数字"猜的：
 * 格子里已有字符时再打一位，DOM 值瞬时变两位，一次普通键入就被当成粘贴，
 * 整串从这一格起前移、本该输入的末位被静默丢掉，界面零提示。
 * **位数不是粘贴的证据，inputType 才是。**
 */
export function applyInput(
  value: string,
  index: number,
  raw: string,
  pasted: boolean,
): CodeEdit | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (pasted) {
    return {
      value: (value.slice(0, index) + digits).slice(0, OTP_LENGTH),
      focus: index + digits.length,
    };
  }
  const chars = value.padEnd(OTP_LENGTH, ' ').split('');
  chars[index] = digits[0];
  return {
    value: chars.join('').replace(/ /g, '').slice(0, OTP_LENGTH),
    focus: index + 1,
  };
}

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
    const el = boxes.current[Math.min(Math.max(index, 0), OTP_LENGTH - 1)];
    el?.focus();
    // 已经聚焦在这一格时 focus() 不再触发 onFocus，全选就轮不到——最后一格尤其
    // （focusAt(6) 会被夹回第 6 格），那格的旧字符选不上，maxLength=1 会让下一次键入
    // 被浏览器直接吞掉。所以这里补一次 select，不靠 onFocus 兜。
    el?.select();
  };

  const handleInput = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const edit = applyInput(
      value,
      index,
      e.target.value,
      (e.nativeEvent as Partial<InputEvent>).inputType === 'insertFromPaste',
    );
    if (!edit) return;
    onChange(edit.value);
    focusAt(edit.focus);
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
        <Input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          value={value[i] ?? ''}
          onChange={(e) => handleInput(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          // 进到一格就把里面的旧字符选上：重打时新字符是替换，不是追加到旧字符后面。
          onFocus={(e) => e.currentTarget.select()}
          // 全选没生效时的兜底——浏览器直接拒收第二个字符，宁可这一下不响应，
          // 也好过悄悄把整串前移。
          maxLength={1}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`第 ${i + 1} 位`}
          aria-invalid={invalid ? true : undefined}
          className="num min-w-11 px-0 text-center text-[20px] font-semibold caret-primary"
        />
      ))}
    </div>
  );
}
