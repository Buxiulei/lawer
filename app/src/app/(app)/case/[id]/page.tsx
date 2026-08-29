import type { Metadata } from 'next';
import { Dashboard } from './_components/Dashboard';

export const metadata: Metadata = { title: '驾驶舱' };

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Dashboard caseId={id} />;
}
