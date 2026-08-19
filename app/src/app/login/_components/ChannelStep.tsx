'use client';

import { useEffect, useState } from 'react';
import {
  OTP_LENGTH,
  OTP_RESEND_SECONDS,
  mockSendCode,
  mockVerifyCode,
} from '@/app/_mock/authpay';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { CodeInput } from './CodeInput';

/**
 * 一个验证通道的完整交互：填标识 → 发码 → 输码 → 校验。
 * 手机与邮箱两步共用，差别只在文案与输入框属性。
 */
export function ChannelStep({
  fieldLabel,
  fieldHint,
  placeholder,
  inputType,
  inputMode,
  autoComplete,
  value,
  onValueChange,
  valid,
  invalidHint,
  maskedTarget,
  codeHint,
  gateOk = true,
  gateHint,
  ctaLabel,
  onSuccess,
}: {
  fieldLabel: string;
  fieldHint: string;
  placeholder: string;
  inputType: 'tel' | 'email';
  inputMode: 'numeric' | 'email';
  autoComplete: string;
  value: string;
  onValueChange: (next: string) => void;
  valid: boolean;
  invalidHint: string;
  maskedTarget: string;
  codeHint: string;
  gateOk?: boolean;
  gateHint?: string;
  ctaLabel: string;
  onSuccess: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const send = async () => {
    if (!valid) {
      setError(invalidHint);
      return;
    }
    setError(null);
    setSending(true);
    await mockSendCode();
    setSending(false);
    setSent(true);
    setCode('');
    setCooldown(OTP_RESEND_SECONDS);
  };

  const submit = async () => {
    setVerifying(true);
    const ok = await mockVerifyCode(code);
    setVerifying(false);
    if (!ok) {
      setError('验证码是 6 位数字，再核对一下');
      return;
    }
    setError(null);
    onSuccess();
  };

  if (!sent) {
    return (
      <div className="flex flex-col gap-4">
        <Input
          label={fieldLabel}
          hint={fieldHint}
          error={error ?? undefined}
          type={inputType}
          inputMode={inputMode}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
            setError(null);
          }}
        />
        <Button fullWidth disabled={!valid || !gateOk || sending} onClick={send}>
          {sending ? '正在发送…' : '发送验证码'}
        </Button>
        {!gateOk && gateHint && (
          <p className="text-[13px] leading-5 text-ink-2">{gateHint}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[14px] font-medium text-ink">输入 {OTP_LENGTH} 位验证码</p>
        <p className="num mt-1 text-[13px] leading-5 text-ink-2">
          已发送至 {maskedTarget}
        </p>
      </div>

      <CodeInput
        value={code}
        onChange={(next) => {
          setCode(next);
          setError(null);
        }}
        invalid={Boolean(error)}
        disabled={verifying}
        autoFocus
      />

      {error ? (
        <p className="text-[13px] leading-5 text-danger">{error}</p>
      ) : (
        <p className="text-[13px] leading-5 text-ink-2">{codeHint}</p>
      )}

      <Button
        fullWidth
        disabled={code.length < OTP_LENGTH || verifying}
        onClick={submit}
      >
        {verifying ? '正在核对…' : ctaLabel}
      </Button>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setError(null);
          }}
          className="num flex min-h-11 items-center text-[14px] text-ink-2 hover:text-ink"
        >
          换一个{fieldLabel}
        </button>
        <button
          type="button"
          disabled={cooldown > 0 || sending}
          onClick={send}
          className="num flex min-h-11 items-center text-[14px] text-primary-ink disabled:text-ink-2"
        >
          {cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送'}
        </button>
      </div>
    </div>
  );
}
