import type { Metadata } from 'next';
import { demoCase } from '@/app/_mock/demo';
import { mockDocs } from '@/app/_mock/docs-drafts';
import { DocsListView } from './_components/DocsListView';
import { RealDocs } from './_components/RealDocs';

export const metadata: Metadata = { title: '文件解读' };

/**
 * 【谁看到什么】演示案件走 mock（那四份「星曜网络」的文件是给人看产品长什么样的），
 * 其余一律现查接口。这里原本对**任何 caseId** 都渲染 mockDocs，
 * 于是真实用户在自己案子的文件解读页上，读到的是别家公司的解除通知与协商协议；
 * 后来改成恒空态，因为 company_docs 那时没有任何写入路径，查了也只会是空。
 * 现在 doc_submit 把通路接上了，这一页改成取真数据——**空态照旧留着**（RealDocs 里判空）。
 */
export default async function DocsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id === demoCase.id) return <DocsListView caseId={id} docs={mockDocs} />;
  return <RealDocs caseId={id} />;
}
