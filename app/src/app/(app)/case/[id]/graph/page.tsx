import type { Metadata } from 'next';
import { CompanyGraphLoader } from './_components/CompanyGraphLoader';

export const metadata: Metadata = { title: '公司图谱' };

export default async function CompanyGraphPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 取数在客户端（本站没有服务端渲染的鉴权页，带 token 的请求一律由浏览器发起，
  // 见 _ui/auth 文件头），所以这里只把 caseId 递下去。
  return <CompanyGraphLoader caseId={id} />;
}
