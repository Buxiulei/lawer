import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/shadcn/button';
import { LampMark } from '@/components/shell/LampMark';

export const metadata: Metadata = { title: '档案已创建' };

/**
 * 注册完成页：双验证走完之后落在这里。
 * 只给两个去处——先去首诊（主路），或者去拿接入密钥（给自己接工具用的少数人）。
 * 裸布局，不套 AppShell：此时还没有当前案件，底部 Tab 无处可指。
 */
export default function WelcomePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <LampMark className="size-7 text-primary" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          <h1 className="mt-6 text-[22px] font-semibold text-ink">档案已创建</h1>
          <p className="prose-measure mt-3 text-[15px] leading-7 text-ink-2">
            手机号和邮箱都验证过了，你的档案已经建好。接下来花几分钟做一次首诊，说清楚现在走到哪一步、公司给了什么说法，系统会算出你的诉求金额和最近的几个期限。
          </p>
        </header>

        <div className="flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link href="/intake">开始首诊</Link>
          </Button>
          <Button asChild variant="secondary" className="w-full">
            <Link href="/settings#api-keys">生成接入密钥</Link>
          </Button>
          <p className="text-[13px] leading-6 text-ink-2">
            接入密钥用来把这个档案接到自己的工具里（例如 Claude
            这类支持 MCP 的客户端）。不需要的话跳过就行，之后在设置里随时能建。
          </p>
        </div>
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        材料加密存储，只用于验证、通知和存证出具。
      </footer>
    </div>
  );
}
