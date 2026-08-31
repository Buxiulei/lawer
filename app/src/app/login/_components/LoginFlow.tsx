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
import { apiFetch } from '@/app/_ui/api';
import { writeToken } from '@/app/_ui/auth';
import { cn } from '@/app/_ui/cn';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { Checkbox } from '@/components/shadcn/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/shadcn/tabs';
import { ChannelStep } from './ChannelStep';

/** 登录完成后落在这里：档案已创建的引导页 */
const AFTER_LOGIN = '/welcome';

/** 只在「新号补绑邮箱」这条路上显示的两格进度；单因素登录一步就完，没什么好指的 */
const COMPLETION_STEPS = ['手机验证', '邮箱验证'];

interface SendResponse {
  ttl_seconds: number;
  retry_after: number;
}

/** need_email=true = 这个账号的注册还没走完（邮箱没验过），得接着补；老用户登录恒为 false */
interface PhoneVerifyResponse {
  token: string;
  need_email: boolean;
}

type Channel = 'phone' | 'email';

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'phone', label: '手机号' },
  { key: 'email', label: '邮箱' },
];

/**
 * 登录：**手机号或邮箱，验一个就进**。
 *
 * 只有一种情况要验两样——手机号验完发现这个号还没有账号，也就是注册。
 * 那时后端回 need_email=true，这里才切到补绑邮箱那一步（邮箱是换手机号后找回账号、
 * 以及收文书与存证证明的唯一落点，建号时不收，用户丢了号就再也回不来）。
 * 老用户走哪条通道都只有一步，两条通道各自独立可登录。
 */
export function LoginFlow() {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>('phone');
  /** true = 手机验过了、是个新号，正停在补绑邮箱那一步（此时请求带 token） */
  const [completing, setCompleting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  /** 邮箱那一格：登录与补绑共用同一个组件，差别只在带不带 token 与两句文案 */
  const emailStep = (
    <ChannelStep
      key={completing ? 'email-completion' : 'email-login'}
      fieldLabel="邮箱"
      fieldHint={
        completing
          ? '换手机号时用它找回账号，文书和存证证明也会发到这里。'
          : '注册时绑定过的那个邮箱，验证码发到这里。'
      }
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
      gateOk={completing || agreed}
      gateHint="先勾选下方的说明，再发送验证码。"
      ctaLabel={completing ? '完成，开始' : '验证并登录'}
      onSend={async () => {
        const res = await apiFetch<SendResponse>('/auth/email/send', {
          method: 'POST',
          body: { email: email.trim() },
          // 补绑要带 token（说明是"给哪个号绑"）；登录不带，落在哪个账号由邮箱本身决定
          auth: completing,
        });
        return res.retry_after;
      }}
      onVerify={async (code) => {
        const res = await apiFetch<{ token: string }>('/auth/email/verify', {
          method: 'POST',
          body: { email: email.trim(), code },
          auth: completing,
        });
        // 后端换发了新 token（补绑那一路此时双验证已齐），要覆盖旧的
        writeToken(res.token);
        router.push(AFTER_LOGIN);
      }}
    />
  );

  if (completing) {
    return (
      <div className="flex flex-col gap-5">
        <Steps current={1} />
        <Card className="p-5">{emailStep}</Card>
        <p className="text-[13px] leading-5 text-ink-2">
          这是新账号，还差一个邮箱：换手机号时靠它找回账号，文书和存证证明也发到这里。只这一次。
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCompleting(false)}
          className="self-start px-2 text-[14px] text-ink-2"
        >
          返回上一步
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={channel} onValueChange={(key) => setChannel(key as Channel)}>
        <TabsList>
          {CHANNELS.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card className="p-5">
        {channel === 'phone' ? (
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
            ctaLabel="验证并登录"
            onSend={async () => {
              const res = await apiFetch<SendResponse>('/auth/sms/send', {
                method: 'POST',
                body: { phone: phone.trim() },
                auth: false,
              });
              return res.retry_after;
            }}
            onVerify={async (code) => {
              const res = await apiFetch<PhoneVerifyResponse>('/auth/sms/verify', {
                method: 'POST',
                body: { phone: phone.trim(), code },
                auth: false,
              });
              writeToken(res.token);
              if (res.need_email) setCompleting(true);
              else router.push(AFTER_LOGIN);
            }}
          />
        ) : (
          emailStep
        )}
      </Card>

      {/* 点整条由浏览器转发给里面的 Checkbox（button 是 labelable 元素），
          这一层不要再挂 onClick，否则勾选状态会被切两次。 */}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] bg-surface-2 p-3.5">
        <Checkbox
          checked={agreed}
          onCheckedChange={(next) => setAgreed(next === true)}
          className="mt-1"
        />
        <span className="text-[14px] leading-6 text-ink-2">
          我已阅读并理解：{DISCLAIMER_TEXT}
        </span>
      </label>
    </div>
  );
}

/** 「1 手机验证 → 2 邮箱验证」：只在新号注册这一路出现，老用户看不到。 */
function Steps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {COMPLETION_STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'num flex size-6 items-center justify-center rounded-full text-[13px] font-semibold',
                done && 'bg-primary-wash text-primary-ink',
                active && 'bg-primary text-on-primary',
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
            {i < COMPLETION_STEPS.length - 1 && (
              <span className="ml-1 h-px w-6 bg-line" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}
