import type { Metadata } from 'next';
import { mockCompanyGraph } from '@/app/_mock/company-graph';
import { CompanyGraphView } from './_components/CompanyGraphView';

export const metadata: Metadata = { title: '公司图谱' };

export default function CompanyGraphPage() {
  // 接后端前取 mock；后续换成 GET /api/v1/cases/:id/company-graph，没查到就传 null。
  return <CompanyGraphView graph={mockCompanyGraph} />;
}
