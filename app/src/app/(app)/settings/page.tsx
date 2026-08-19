import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '设置' };

export default function SettingsPage() {
  return (
    <PagePlaceholder
      pageName="设置"
      description="通知渠道、低调模式默认值、数据导出与账号注销正在开发中。"
    />
  );
}
