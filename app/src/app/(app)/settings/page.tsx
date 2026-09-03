import type { Metadata } from 'next';
import { AgentKeyCards } from './_components/AgentKeyCards';
import { PreferencesCard } from './_components/PreferencesCard';
import { RealnameCard } from './_components/RealnameCard';

export const metadata: Metadata = { title: '设置' };

export default function SettingsPage() {
  return (
    <div className="pt-1 pb-4">
      <header className="py-3">
        <h1 className="text-[22px] leading-8 font-semibold tracking-tight text-ink">设置</h1>
      </header>

      <div className="mt-2 flex flex-col gap-4">
        <RealnameCard />
        {/* API key 卡 + 接入卡：两张吃同一份密钥 state，见 AgentKeyCards */}
        <AgentKeyCards />
        <PreferencesCard />
      </div>
    </div>
  );
}
