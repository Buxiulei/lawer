import type { Metadata } from 'next';
import { demoCase } from '@/app/_mock/demo';
import { mockDrafts } from '@/app/_mock/docs-drafts';
import { DraftsListView } from './_components/DraftsListView';
import { RealDrafts } from './_components/RealDrafts';

export const metadata: Metadata = { title: '文书' };

/**
 * 【谁看到什么】演示案件走 mock（那几份「星曜网络」的文书是给人看产品长什么样的），
 * 其余一律现查接口。这里原本是一行 `const drafts = mockDrafts`——**对任何 caseId 都是它**，
 * 于是真实用户在自己案子的文书页上读到别家公司的异议函和仲裁申请书。
 */
export default async function DraftsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id === demoCase.id) return <DraftsListView caseId={id} drafts={mockDrafts} />;
  return <RealDrafts caseId={id} />;
}
