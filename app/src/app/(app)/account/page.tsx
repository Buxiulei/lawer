import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '我的' };

export default function AccountPage() {
  return (
    <PagePlaceholder
      pageName="我的 · 公道值"
      description="余额、流水、套餐与实名状态正在开发中。"
    />
  );
}
