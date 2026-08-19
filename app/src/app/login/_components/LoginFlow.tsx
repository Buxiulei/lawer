'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DISCLAIMER_TEXT,
  isEmail,
  isPhone,
  maskEmail,
  maskPhone,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { ChannelStep } from './ChannelStep';

const STEP_LABELS = ['手机验证', '邮箱验证'];
const DEMO_CASE_ID = 'demo';

export function LoginFlow() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  return (
    <div className="flex flex-col gap-5">
      <Steps current={step} />

      <div className="rounded-[12px] border border-line bg-surface p-5 shadow-soft">
        {step === 0 ? (
          <ChannelStep
            key="phone"
            fieldLabel="手机号"
            fieldHint="用于接收验证码和开庭前的期限提醒，不会对外展示。"
            placeholder="11 位手机号"
            inputType="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={phone}
            onValueChange={setPhone}
            valid={isPhone(phone)}
            invalidHint="手机号是 11 位数字，再核对一下"
            maskedTarget={maskPhone(phone)}
            codeHint="收不到就等验证码倒计时结束后重发一次。"
            gateOk={agreed}
            gateHint="先勾选下方的说明，再发送验证码。"
            ctaLabel="下一步：验证邮箱"
            onSuccess={() => setStep(1)}
          />
        ) : (
          <ChannelStep
            key="email"
            fieldLabel="邮箱"
            fieldHint="换手机号时用它找回账号，文书和存证证明也会发到这里。"
            placeholder="you@example.com"
            inputType="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onValueChange={setEmail}
            valid={isEmail(email)}
            invalidHint="邮箱格式不太对，再核对一下"
            maskedTarget={maskEmail(email)}
            codeHint="邮件可能进垃圾箱，找一下带「验证码」字样的那封。"
            ctaLabel="完成，开始"
            onSuccess={() => router.push(`/case/${DEMO_CASE_ID}`)}
          />
        )}
      </div>

      {step === 0 ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] bg-surface-2 p-3.5">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 size-5 shrink-0 accent-primary"
          />
          <span className="text-[14px] leading-6 text-ink-2">
            我已阅读并理解：{DISCLAIMER_TEXT}
          </span>
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setStep(0)}
          className="flex min-h-11 items-center self-start text-[14px] text-ink-2 hover:text-ink"
        >
          返回上一步
        </button>
      )}
    </div>
  );
}

/** 「1 手机验证 → 2 邮箱验证」：两步都必须走完（spec D1）。 */
function Steps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {STEP_LABELS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'num flex size-6 items-center justify-center rounded-full text-[13px] font-semibold',
                done && 'bg-primary-wash text-primary-ink',
                active && 'bg-primary text-white',
                !done && !active && 'bg-surface-2 text-ink-2',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              className={cn(
                'text-[14px]',
                active ? 'font-semibold text-ink' : 'text-ink-2',
              )}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <span className="ml-1 h-px w-6 bg-line" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}
