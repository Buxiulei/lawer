'use client';

import { useEffect, useState } from 'react';
import { ApiError, humanError } from '@/app/_ui/api';
import { OTP_LENGTH, OTP_RESEND_SECONDS } from '@/app/_mock/authpay';
import { Button } from '@/components/shadcn/button';
import { InputField } from '@/components/shadcn/field';
import { CodeInput } from './CodeInput';
import { NO_RESUME, saveLoginStep, type LoginChannel, type LoginResume } from './loginStep';

/**
 * 一个验证通道的完整交互：填标识 → 发码 → 输码 → 校验。
 * 手机通道、邮箱通道、以及新号补绑邮箱那一步共用，差别只在文案、输入框属性与传进来的两个接口调用。
 *
 * 发码/校验都由外部注入：本组件不认识 /auth/sms 还是 /auth/email，
 * 只负责把失败翻成一句人话摆在用户眼前，以及管住 60 秒重发。
 *
 * 【为什么半程记录写在这里】"码发出去了没有"和"还有几秒能重发"这两样状态就长在这个组件里，
 * 别处拿不到。它们没落盘，就是 F5 之后人被退回手机号那一格、短信却已经发出去的那个洞
 * （见 loginStep.ts）。所以 persistAs 只告诉它"这一格算哪条通道的半程"，
 * 它照旧不认识具体接口。
 *
 * 【读半程记录不在这里】**写**在这里、**读**由 LoginFlow 挂载后统一做一次，
 * 结果当 prop 传进来。这个组件自己去读 sessionStorage 的那一版，
 * 会让首帧的客户端渲染跟服务端渲染对不上（React #418），见 LoginFlow 的长注释。
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
  persistAs,
  resume = NO_RESUME,
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
  /** 这一格属于哪条通道的半程（刷新后靠它认领自己那条记录） */
  persistAs: LoginChannel;
  /**
   * 半程记录：读完了没有、读到了什么（由 LoginFlow 读、逐层传下来）。
   * 通道对不上就当没有——三条通道共用这一个组件，认错了会把别人的号填进来。
   */
  resume?: LoginResume;
  /** 发码；resolve 出的秒数用作重发倒计时，失败请 throw */
  onSend: () => Promise<number>;
  /** 校验；成功即推进，失败请 throw */
  onVerify: (code: string) => Promise<void>;
}) {
  /** 这一格是不是接着半程走的。整块由 LoginFlow 按记录重挂，所以这里直接算即可 */
  const resumed = resume.step?.channel === persistAs ? resume.step : null;
  const [sent, setSent] = useState(resumed?.step === 'code');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 可以重发的**时刻**（epoch ms）。存时刻不存剩余秒数，刷新后才接得上，见 loginStep.ts */
  const [resendAt, setResendAt] = useState(resumed?.expiresAt ?? 0);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /**
   * 半程记录的**唯一写入口**：这一格的状态变一次就落一次盘。
   * 不分散到 send / 重发 / 「换一个」三处各写一遍——那是三次忘掉其中一处的机会，
   * 而忘掉的现象是刷新后回到**上一个**状态，没有任何报错。
   */
  useEffect(() => {
    // 记录还没读完之前一个字都不许写：这时这一格是默认态（没发码、什么都没填），
    // 写下去正好把要恢复的那条抹掉。**子组件的 effect 比父组件先跑**（React 定的顺序），
    // 所以"父组件挂载后去读"挡不住这一下——真机现象是 F5 后照样掉回手机号格，零报错。
    if (!resume.ready) return;
    saveLoginStep({
      channel: persistAs,
      step: sent ? 'code' : 'entry',
      target: value,
      expiresAt: resendAt,
    });
  }, [resume.ready, persistAs, sent, value, resendAt]);

  /**
   * 开一轮新冷却。要先对表：now 只在倒计时跑动时才刷新，
   * 页面开着放了五分钟再发码的话，拿旧的 now 去减会算出五分钟的倒计时。
   */
  const startCooldown = (seconds: number) => {
    const from = Date.now();
    setNow(from);
    setResendAt(from + seconds * 1000);
  };

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
      startCooldown(seconds > 0 ? seconds : OTP_RESEND_SECONDS);
    } catch (err) {
      setError(humanError(err));
      // 被限流时倒计时照后端给的 retry_after 走，别让用户再白点一次
      if (err instanceof ApiError && err.retryAfter) startCooldown(err.retryAfter);
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
        {/*
          按钮为什么是灰的，两个原因各说各的，都不满足就两条都说。
          原先只说"先勾选下方的说明"：号码少打一位的人照着勾了，按钮还是灰的，
          于是唯一的提示反而把人指到了错的地方。
          号码这句只在真填过东西之后才出现——空格子还没开始填，不该先挨一句"不对"。
        */}
        {value.trim() !== '' && !valid && (
          <p className="text-[13px] leading-5 text-ink-2">{invalidHint}</p>
        )}
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
