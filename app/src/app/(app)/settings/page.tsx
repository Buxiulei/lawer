import type { Metadata } from 'next';
import { AgentKeyCards } from './_components/AgentKeyCards';
import { DataRightsCard } from './_components/DataRightsCard';
import { PreferencesCard } from './_components/PreferencesCard';
import { PrivacyCard } from './_components/PrivacyCard';
import { RealnameCard } from './_components/RealnameCard';
import { ReferralCard } from './_components/ReferralCard';

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
        {/* 转介状态卡：**只在有转介记录时自己渲染**，没有记录整张卡不出现（见 ReferralCard） */}
        <ReferralCard />
        {/* 隐私与同意（境外模型 / 评测授权 / 情绪记录）：摆在通用偏好之前，
            因为它管的是「我们能拿你的数据做什么」，比主题与震动重要 */}
        <PrivacyCard />
        {/* 协议附一第 7 项的四个入口（案件删除 / 整案导出 / 账号注销 / 撤回同意）都在这张卡里；
            撤回同意后两条通路回给用户的那句话就是把人指到这儿的（见 DataRightsCard 抬头）。 */}
        <DataRightsCard />
        <PreferencesCard />
      </div>
    </div>
  );
}
