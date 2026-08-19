import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: '存证验证' };

/**
 * 公开验证页：无需登录、不套 AppShell。
 * 任何人拿到存证编号都能在这里复核哈希与时间戳。
 */
export default async function VerifyPage({
  params,
}: {
  params: Promise<{ no: string }>;
}) {
  const { no } = await params;

  return (
    <div className="mx-auto min-h-dvh w-full max-w-[720px] px-4 py-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-[20px] font-semibold text-ink">存证验证</h1>
        <p className="num mt-1 text-[15px] text-ink-2">存证编号 {no}</p>
      </header>
      <div className="pt-6">
        <EmptyState
          title="页面建设中"
          description="文件哈希、可信时间戳与证书链的离线复核界面正在开发中。"
        />
      </div>
    </div>
  );
}
