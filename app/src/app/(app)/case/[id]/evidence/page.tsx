import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '证据库' };

export default function EvidencePage() {
  return (
    <PagePlaceholder
      pageName="证据库"
      description="上传、分类、时间戳固化与存证出证的列表页正在开发中。"
    />
  );
}
