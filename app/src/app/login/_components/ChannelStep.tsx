'use client';

import { useEffect, useState } from 'react';
import { ApiError, humanError } from '@/app/_ui/api';
import { OTP_LENGTH, OTP_RESEND_SECONDS } from '@/app/_mock/authpay';
import { Button } from '@/components/shadcn/button';
import { InputField } from '@/components/shadcn/field';
import { CodeInput } from './CodeInput';

/**
 * 一个验证通道的完整交互：填标识 → 发码 → 输码 → 校验。
 * 手机通道、邮箱通道、以及新号补绑邮箱那一步共用，差别只在文案、输入框属性与传进来的两个接口调用。
 *
 * 发码/校验都由外部注入：本组件不认识 /auth/sms 还是 /auth/email，
 * 只负责把失败翻成一句人话摆在用户眼前，以及管住 60 秒重发。
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
  onSend,
  onVerify,
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
  /** 发码；resolve 出的秒数用作重发倒计时，失败请 throw */
  onSend: () => Promise<number>;
  /** 校验；成功即推进，失败请 throw */
  onVerify: (code: string) => Promise<void>;
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
    try {
      const seconds = await onSend();
      setSent(true);
      setCode('');
      setCooldown(seconds > 0 ? seconds : OTP_RESEND_SECONDS);
    } catch (err) {
      setError(humanError(err));
      // 被限流时倒计时照后端给的 retry_after 走，别让用户再白点一次
      if (err instanceof ApiError && err.retryAfter) setCooldown(err.retryAfter);
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    setVerifying(true);
    try {
      await onVerify(code);
      setError(null);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setVerifying(false);
    }
  };

  if (!sent) {
    return (
      <div className="flex flex-col gap-4">
        <InputField
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
        <Button className="w-full" disabled={!valid || !gateOk || sending} onClick={send}>
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
        <p className="text-[13px] leading-5 text-danger-ink">{error}</p>
      ) : (
        <p className="text-[13px] leading-5 text-ink-2">{codeHint}</p>
      )}

      <Button
        className="w-full"
        disabled={code.length < OTP_LENGTH || verifying}
        onClick={submit}
      >
        {verifying ? '正在核对…' : ctaLabel}
      </Button>

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSent(false);
            setError(null);
          }}
          className="px-2 text-[14px] text-ink-2"
        >
          换一个{fieldLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={cooldown > 0 || sending}
          onClick={send}
          className="num px-2 text-[14px]"
        >
          {cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送'}
        </Button>
      </div>
    </div>
  );
}
