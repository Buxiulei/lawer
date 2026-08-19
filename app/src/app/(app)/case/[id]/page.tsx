import type { Metadata } from 'next';
import { Workbench } from './_components/Workbench';

export const metadata: Metadata = { title: '工作台' };

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Workbench caseId={id} />;
}
