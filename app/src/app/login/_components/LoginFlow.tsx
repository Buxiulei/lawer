'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  DISCLAIMER_TEXT,
  isEmail,
  isPhone,
  maskEmail,
  maskPhone,
} from '@/app/_mock/authpay';
import { apiFetch } from '@/app/_ui/api';
import { cn } from '@/app/_ui/cn';
import { beginSession } from '@/app/_ui/session';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { Checkbox } from '@/components/shadcn/checkbox';
import { ChannelStep } from './ChannelStep';
import { clearLoginStep, loadLoginStep, NO_RESUME, type LoginResume } from './loginStep';

/** 登录完成后落在这里：/welcome 会先问一句「你是新来的还是回来的」再决定说什么 */
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

/**
 * 引言：说的是**眼前这一格**要填什么、大概多久，所以它跟着通道换。
 *
 * 【为什么不能留在 page.tsx】那一页是无状态的服务端组件（/login 要保持静态预渲染），
 * 换不动通道：点进邮箱那屏之后，顶上仍写着"手机号验证码登录"，跟下面的邮箱表单对不上。
 *
 * 【为什么只说眼前这一步】补绑邮箱是**少数人**（新号注册那一次）才会撞上的支路，
 * 预先摆在首屏上，等于让所有人先替那批人担一次心：
 * 「原来要验两样」是那种句子造成的误解，不是流程本身。
 */
const CHANNEL_INTRO: Record<Channel, string> = {
  phone: '手机号验证码登录，大约半分钟。',
  email: '邮箱验证码登录，大约半分钟。',
};

/**
 * 登录：**手机号或邮箱，验一个就进**；手机号是主路，邮箱收在一条次级入口后面。
 *
 * 【为什么不是两个平等的 Tab】两条路都能登录不等于两条路一样常用：
 * 摆成并排的 Tab，等于要求每个进来的人先替自己选一次通道，而绝大多数人的答案都是手机号。
 * 邮箱那条仍然是完整的独立入口（老用户绑过邮箱后可以只用它进），只是**默认不占首屏**。
 *
 * 只有一种情况要验两样——手机号验完发现这个号还没有账号，也就是注册。
 * 那时后端回 need_email=true，这里才切到补绑邮箱那一步（邮箱是换手机号后找回账号、
 * 以及收文书与存证证明的唯一落点，建号时不收，用户丢了号就再也回不来）。
 * 老用户走哪条通道都只有一步。
 *
 * 【这些 state 都是可恢复的】刷新一下就全没，人被静默退回手机号那一格，
 * 而短信已经发出去了——补绑那一步更糟，token 已经在手上，人却被打回登录第一格。
 * 所以要问一次半程记录（sessionStorage，关标签页即清），见 loginStep.ts。
 */
export function LoginFlow() {
  const resume = useResumedLoginStep();
  // 记录到手那一刻整块重挂，让下面各格的初始 state 按记录重新播种。
  // 没有记录时 key 一直是 fresh，压根不会重挂。
  return <LoginForm key={resume.step ? 'resumed' : 'fresh'} resume={resume} />;
}

/**
 * 半程记录：**挂载之后**才读，首帧一律当"没有半程"。
 *
 * 【为什么不能在初始 state 里读】服务端渲染时根本没有 sessionStorage
 * （loadLoginStep 吞掉异常返回 null），客户端首帧却读得到——两边首帧不一样，
 * 就是生产 console 里那条 React #418 hydration mismatch。
 *
 * 【为什么"挪到挂载后会闪一帧"这个顾虑不成立】用户眼里的第一帧是**服务端那一帧**，
 * 它从来就没有半程（服务端读不到 sessionStorage）。也就是说"先看到手机号格再跳过来"
 * 在修之前也照样发生，只是外带一条报错，而 mismatch 会让 React 把整棵树重渲一遍。
 * 挪到挂载后，可见行为不变，报错没了。
 *
 * 【ready 那一位不是多余的】读完之前**谁都不许写** sessionStorage：
 * 各格的落盘 effect 比这里先跑（子组件 effect 先于父组件，React 定的顺序），
 * 它写下去的是"这一格的默认态"，正好把要恢复的那条抹掉。
 * 少了这一位，真机上 F5 照样掉回手机号格，而且一个报错都没有。
 */
function useResumedLoginStep(): LoginResume {
  const [resume, setResume] = useState<LoginResume>({ ready: false, step: null });
  useEffect(() => setResume({ ready: true, step: loadLoginStep() }), []);
  return resume;
}

/**
 * 登录表单本体。半程记录当 prop 收，不自己去读——
 * 「什么时候读 sessionStorage」这件事只由上面那个 hook 说了算。
 */
export function LoginForm({ resume }: { resume: LoginResume }) {
  const resumed = resume.step;
  const enterSite = useEnterSite();
  const [channel, setChannel] = useState<Channel>(resumed?.channel === 'email' ? 'email' : 'phone');
  /** true = 手机验过了、是个新号，正停在补绑邮箱那一步（此时请求带 token） */
  const [completing, setCompleting] = useState(resumed?.channel === 'completion');
  const [agreed, setAgreed] = useState(false);
  const [phone, setPhone] = useState(resumed?.channel === 'phone' ? resumed.target : '');
  const [email, setEmail] = useState(
    resumed && resumed.channel !== 'phone' ? resumed.target : '',
  );

  if (completing) {
    return (
      <CompletionPane
        email={email}
        onEmailChange={setEmail}
        agreed={agreed}
        resume={resume}
        onBack={() => setCompleting(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <ChannelIntro channel={channel} />
      {channel === 'email' ? (
        <EmailPane
          email={email}
          onEmailChange={setEmail}
          agreed={agreed}
          resume={resume}
          onBack={() => setChannel('phone')}
        />
      ) : (
        <Card className="p-5">
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
            persistAs="phone"
            resume={resume}
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
              beginSession(res.token);
              if (res.need_email) setCompleting(true);
              else enterSite();
            }}
          />
        </Card>
      )}

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

      {channel === 'phone' && (
        <ChannelSwitchLink onClick={() => setChannel('email')}>用邮箱登录 →</ChannelSwitchLink>
      )}
    </div>
  );
}

/**
 * 引言那一句。单独成组件，是因为 LoginFlow 自己的 channel state 在 SSR 判据里驱动不了：
 * 两种取值只有能各自渲染，「引言跟着通道换」这件事才盯得住
 * （它错位时页面照常能用，只有用户对着邮箱表单读到"手机号验证码登录"）。
 */
export function ChannelIntro({ channel }: { channel: Channel }) {
  return <p className="text-[15px] leading-7 text-ink-2">{CHANNEL_INTRO[channel]}</p>;
}

/**
 * 登录成功的**唯一出口**：先擦掉半程记录，再进站。
 *
 * 收成一处，是因为出口有两个（手机号验完就进 / 邮箱那条路验完就进），
 * 而"漏擦了一处"的现象是**下一次打开登录页被丢回上一回的验证码格**——
 * 那时码早就过期了，人得自己看出来该点「换一个手机号」。没有任何报错。
 */
function useEnterSite(): () => void {
  const router = useRouter();
  return () => {
    clearLoginStep();
    router.push(AFTER_LOGIN);
  };
}

/**
 * 换通道那一行：首屏底下的「用邮箱登录 →」和邮箱那屏顶上的「← 用手机号登录」是同一个东西。
 *
 * 收成一处，是因为「次级入口长什么样」这件事有一条**不能靠记性维持**的约束：
 * 样子要轻（ghost 文字链、贴左不铺满，跟 w-full 的实心主 CTA 一眼分得开），
 * 触区不能跟着轻（size=sm 即 h-11=44px）。分散写两遍，就是两次忘掉后半句的机会。
 */
function ChannelSwitchLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="self-start px-2 text-[15px]">
      {children}
    </Button>
  );
}

/**
 * 邮箱登录那一屏：从次级入口点进来的形态——顶上一行回手机号，下面是邮箱那一格。
 *
 * 单独成组件的理由和 EmailChannel 一样：它是 channel 的一个取值，
 * 而 LoginFlow 自己的 state 在 SSR 判据里驱动不了，只有能独立渲染才盯得住
 * （少了那行返回，用户就被关在邮箱这屏里出不去，而那是一处静默失效）。
 */
export function EmailPane({
  email,
  onEmailChange,
  agreed,
  resume = NO_RESUME,
  onBack,
}: {
  email: string;
  onEmailChange: (next: string) => void;
  agreed: boolean;
  resume?: LoginResume;
  /** 回主路（手机号） */
  onBack: () => void;
}) {
  return (
    <>
      <ChannelSwitchLink onClick={onBack}>← 用手机号登录</ChannelSwitchLink>
      <Card className="p-5">
        <EmailChannel
          completing={false}
          email={email}
          onEmailChange={onEmailChange}
          agreed={agreed}
          resume={resume}
        />
      </Card>
    </>
  );
}

/**
 * 补绑邮箱那一屏（只有新号注册那一次走到）：两格进度 → 邮箱那一格 → 为什么要它 → 退路。
 *
 * 单独成组件的理由跟 EmailPane 一样，而这一屏更需要：它藏在 need_email=true 后面，
 * `completing` 在 SSR 判据里驱动不了，于是复审时把两格进度、那段说明、「返回上一步」
 * 各删一次，全套测试仍然全绿。三样都是**静默失效**——删了页面照常能用，
 * 只有走到这一步的新用户不知道自己在哪、为什么要给邮箱、以及怎么退回去。
 */
export function CompletionPane({
  email,
  onEmailChange,
  agreed,
  resume = NO_RESUME,
  onBack,
}: {
  email: string;
  onEmailChange: (next: string) => void;
  agreed: boolean;
  resume?: LoginResume;
  /** 退回手机号那一步 */
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Steps current={1} />
      <Card className="p-5">
        <EmailChannel
          completing
          email={email}
          onEmailChange={onEmailChange}
          agreed={agreed}
          resume={resume}
        />
      </Card>
      <p className="text-[13px] leading-5 text-ink-2">
        这是新账号，还差一个邮箱：换手机号时靠它找回账号，文书和存证证明也发到这里。只这一次。
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="self-start px-2 text-[14px] text-ink-2"
      >
        返回上一步
      </Button>
    </div>
  );
}

/**
 * 邮箱那一格。登录与新号补绑共用同一个通道组件，差别只有两处：文案，
 * 以及**请求带不带 token**——补绑要带（说明「给哪个号绑」），
 * 登录不带（落在哪个账号完全由邮箱本身决定，调用方指定不了）。
 * 那个 auth 标志就是「邮箱能不能单独当入口」在前端的全部落点，所以单独成组件：
 * 它的两种形态能各自渲染，判据才盯得住（LoginFlow 自身的 state 在 SSR 判据里驱动不了）。
 */
export function EmailChannel({
  completing,
  email,
  onEmailChange,
  agreed,
  resume = NO_RESUME,
}: {
  /** true = 新号补绑那一步（带 token）；false = 邮箱通道登录（匿名） */
  completing: boolean;
  email: string;
  onEmailChange: (next: string) => void;
  agreed: boolean;
  resume?: LoginResume;
}) {
  const enterSite = useEnterSite();
  return (
    <ChannelStep
      key={completing ? 'email-completion' : 'email-login'}
      fieldLabel="邮箱"
      fieldHint={
        completing
          ? '换手机号时用它找回账号，文书和存证证明也会发到这里。'
          : // 后端对「这个邮箱注册过没有」一个字都不说（否则接口就成了注册状态探针），
            // 所以打错字的人得不到错误码——这句常驻提示就是替他准备的那份解释。
            // 只讲"没收到码该怎么办"，不讲"你这个邮箱有没有账号"：
            // 句子本身也不能变成那个探针，否则隐私决定在后端守住、在文案上漏掉。
            '验证码发到这个邮箱。还没绑过邮箱的账号，先用手机号登录。'
      }
      placeholder="you@example.com"
      inputType="email"
      inputMode="email"
      autoComplete="email"
      value={email}
      onValueChange={onEmailChange}
      valid={isEmail(email)}
      invalidHint="邮箱格式不太对，再核对一下"
      maskedTarget={maskEmail(email)}
      codeHint="邮件可能进垃圾箱，找一下带「验证码」字样的那封。"
      gateOk={completing || agreed}
      gateHint="先勾选下方的说明，再发送验证码。"
      ctaLabel={completing ? '完成，开始' : '验证并登录'}
      persistAs={completing ? 'completion' : 'email'}
      resume={resume}
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
        beginSession(res.token);
        enterSite();
      }}
    />
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
