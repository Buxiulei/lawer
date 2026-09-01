import type { Metadata } from 'next';
import { demoCase } from '@/app/_mock/demo';
import { mockDocs } from '@/app/_mock/docs-drafts';
import { DocsEmpty } from './_components/DocsEmpty';
import { DocsListView } from './_components/DocsListView';

export const metadata: Metadata = { title: '文件解读' };

/**
 * 【谁看到什么】演示案件走 mock（那四份「星曜网络」的文件是给人看产品长什么样的），
 * 其余一律空态。这里原本对**任何 caseId** 都渲染 mockDocs，
 * 于是真实用户在自己案子的文件解读页上，读到的是别家公司的解除通知与协商协议。
 *
 * 真实案件为什么不是「查表」而是恒空：company_docs 表建好了，但全仓没有任何生产代码
 * 往里写过一行（见 DocsEmpty 的注释），查了也只会是空。等上传-解读通路接上，
 * 这里换成取接口，空态照旧留着。
 */
export default async function DocsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id === demoCase.id) return <DocsListView caseId={id} docs={mockDocs} />;
  return <DocsEmpty caseId={id} />;
}
