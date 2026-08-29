import type { Metadata } from 'next';
import { Workbench } from '../_components/Workbench';

export const metadata: Metadata = { title: '问它' };

export default async function AskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Workbench caseId={id} />;
}
