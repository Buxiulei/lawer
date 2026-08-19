import type { Metadata } from 'next';
import { ApiKeysCard } from './_components/ApiKeysCard';
import { McpCard } from './_components/McpCard';
import { PreferencesCard } from './_components/PreferencesCard';

export const metadata: Metadata = { title: '设置' };

export default function SettingsPage() {
  return (
    <div className="pt-1 pb-4">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">设置</h1>
      </header>

      <div className="flex flex-col gap-4">
        <ApiKeysCard />
        <McpCard />
        <PreferencesCard />
      </div>
    </div>
  );
}
