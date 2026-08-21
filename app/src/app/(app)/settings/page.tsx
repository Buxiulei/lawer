import type { Metadata } from 'next';
import { AgentSetupCard } from './_components/AgentSetupCard';
import { ApiKeysCard } from './_components/ApiKeysCard';
import { PreferencesCard } from './_components/PreferencesCard';
import { RealnameCard } from './_components/RealnameCard';

export const metadata: Metadata = { title: '设置' };

export default function SettingsPage() {
  return (
    <div className="pt-1 pb-4">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">设置</h1>
      </header>

      <div className="flex flex-col gap-4">
        <RealnameCard />
        <ApiKeysCard />
        <AgentSetupCard />
        <PreferencesCard />
      </div>
    </div>
  );
}
