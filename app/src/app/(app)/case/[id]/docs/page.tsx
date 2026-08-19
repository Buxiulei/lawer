import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '文件解读' };

export default function DocsPage() {
  return (
    <PagePlaceholder
      pageName="文件解读"
      description="公司文件 OCR、风险条款标红与签/不签意见的解读页正在开发中。"
    />
  );
}
