import type { Metadata } from 'next';
import Link from 'next/link';
import { HELP_COMPLAINTS_HREF, HELP_COMPLAINTS_TITLE } from '@/app/_ui/termsLinks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
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
        {/* 投诉/举报/个人信息权利请求的入口。**恒常在场**——它与别的卡不同，
            要找它的人多半正在气头上或正要行使删除权，一张"有记录才显示"的卡等于没有入口
            （《生成式人工智能服务管理暂行办法》第十五条要的是"便捷的投诉、举报入口"）。
            正文与表单在 /settings/help，这里只留一条指过去的路。 */}
        <Card>
          <CardHeader>
            <CardTitle>{HELP_COMPLAINTS_TITLE}</CardTitle>
          </CardHeader>
          <CardContent className="text-[14px] leading-7 text-ink-2">
            <p>
              服务出了问题、看到违法或侵权的生成内容、或者要查阅、更正、删除自己的个人信息，
              都从这里提；提交后会给你一个受理编号。
            </p>
            <Link
              href={HELP_COMPLAINTS_HREF}
              className="mt-2 inline-block text-primary-ink underline underline-offset-4"
            >
              去{HELP_COMPLAINTS_TITLE}
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
