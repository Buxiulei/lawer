import type { Metadata } from 'next';
import { mockDocs } from '@/app/_mock/docs-drafts';
import { DocsListView } from './_components/DocsListView';

export const metadata: Metadata = { title: '文件解读' };

export default async function DocsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 接后端前取 mock；后续换成按 caseId 查 company_docs。
  return <DocsListView caseId={id} docs={mockDocs} />;
}
