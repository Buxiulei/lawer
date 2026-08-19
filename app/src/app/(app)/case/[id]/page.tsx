import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '工作台' };

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PagePlaceholder
      pageName="对话工作台"
      description={`案件 ${id} 的对话流、行动卡组与案件档案面板正在开发中。已建成的是导航骨架与基础组件。`}
    />
  );
}
