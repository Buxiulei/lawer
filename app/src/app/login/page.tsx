import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';
import { LampMark } from '@/components/shell/LampMark';

export const metadata: Metadata = { title: '登录' };

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-2.5">
          <LampMark className="size-7 text-primary" />
          <span className="text-[18px] font-semibold text-ink">裁员应对专员</span>
        </div>
        <EmptyState
          title="页面建设中"
          description="登录：手机号验证码 + 邮箱验证双通道正在开发中。"
        />
      </div>
    </div>
  );
}
