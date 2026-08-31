import type { Metadata } from 'next';
import { venueSection } from '@/lib/dossier/venue';
import { DossierLoader } from './_components/DossierLoader';

/**
 * 标题固定「公司档案」，不带公司名——tab title 与顶栏是最容易被旁人瞥见的一条。
 * 低调模式下 bootstrap 脚本还会把它整体换成中性标题。
 */
export const metadata: Metadata = { title: '公司档案' };

export default async function DossierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 知识库 loader 走文件系统，只能在服务端读；demo 的仲裁地卡在这里取好传下去。
  // 真实案件的仲裁地卡由接口随档案一起给（后端同样用 lib/dossier/venue）。
  return <DossierLoader caseId={id} demoVenue={venueSection('北京朝阳')} />;
}
