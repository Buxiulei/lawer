import type { Metadata } from 'next';
import { CaseReportLoader } from './_components/CaseReportLoader';

/**
 * 标题固定「个案报告」，不带案件名——tab title 与顶栏是最容易被旁人瞥见的一条。
 * 低调模式下 bootstrap 脚本还会把它整体换成中性标题。
 */
export const metadata: Metadata = { title: '个案报告' };

export default async function CaseReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 取数在客户端（本站没有服务端渲染的鉴权页，带 token 的请求一律由浏览器发起），
  // 所以这里只把 caseId 递下去。
  return <CaseReportLoader caseId={id} />;
}
