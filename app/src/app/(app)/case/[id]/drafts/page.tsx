import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '文书' };

export default function DraftsPage() {
  return (
    <PagePlaceholder
      pageName="文书"
      description="异议函、仲裁申请书、证据清单等文书的起草与版本管理正在开发中。"
    />
  );
}
