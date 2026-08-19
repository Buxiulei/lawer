import type { Metadata } from 'next';
import { EvidenceLibrary } from './_components/EvidenceLibrary';

export const metadata: Metadata = { title: '证据库' };

export default async function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EvidenceLibrary caseId={id} />;
}
