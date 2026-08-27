import type { Metadata } from 'next';
import { LampMark } from '@/components/shell/LampMark';
import { LoginFlow } from './_components/LoginFlow';

export const metadata: Metadata = { title: '登录' };

/**
 * 登录：手机号 + 邮箱双验证（spec D1）。裸布局，不套 AppShell。
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <LampMark className="size-7 text-primary" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          <p className="mt-3 text-[15px] leading-7 text-ink-2">
            手机号和邮箱都验证一遍，你上传的材料才能绑定到实名、出得了存证。两步，大约一分钟。
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
