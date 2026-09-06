import type { Metadata } from 'next';

import { TubashuMark } from '@/components/shell/TubashuMark';
import { ConsentFlow } from './_components/ConsentFlow';

export const metadata: Metadata = { title: '授权接入' };

/**
 * OAuth 同意页。裸布局、不套 AppShell——用户是从别的产品跳过来的，这一屏只该问一件事：
 * 要不要把自己的档案交给那个客户端读写。左右再摆上导航，反而给了他别的事可做。
 */
export default function OauthAuthorizePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
        </header>

        <ConsentFlow />
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        授权只影响你自己的档案；别人的案件对被授权的客户端一样不可见。
      </footer>
    </div>
  );
}
