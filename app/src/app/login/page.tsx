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
          {/* 引言那一句不在这里：它说的是**眼前这一格**要填什么，得跟着通道换，
              而这一页是无状态的服务端组件（/login 要保持静态预渲染），换不动。
              见 LoginFlow 的 CHANNEL_INTRO。 */}
        </header>

        <LoginFlow />
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        手机号与身份信息加密存储，只用于验证、通知和存证出具。
      </footer>
    </div>
  );
}
