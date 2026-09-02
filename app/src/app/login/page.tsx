import type { Metadata } from 'next';
import { TubashuMark } from '@/components/shell/TubashuMark';
import { LoginFlow } from './_components/LoginFlow';

export const metadata: Metadata = { title: '登录' };

/**
 * 登录：手机号或邮箱，验一个就进；只有新号注册那一次要接着补绑邮箱。裸布局，不套 AppShell。
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          {/* 只说眼前这一步。补绑邮箱是**少数人**（新号注册那一次）才会撞上的支路，
              预先摆在首屏上，等于让所有人先替那批人担一次心：
              「原来要验两样」是这一句造成的误解，不是流程本身。 */}
          <p className="mt-3 text-[15px] leading-7 text-ink-2">
            手机号验证码登录，大约半分钟。
          </p>
        </header>

        <LoginFlow />
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        手机号与身份信息加密存储，只用于验证、通知和存证出具。
      </footer>
    </div>
  );
}
