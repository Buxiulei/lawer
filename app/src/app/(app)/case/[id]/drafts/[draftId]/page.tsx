import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDraft } from '@/app/_mock/docs-drafts';
import { DraftEditor } from '../_components/DraftEditor';

export const metadata: Metadata = { title: '文书' };

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ id: string; draftId: string }>;
}) {
  const { id, draftId } = await params;
  const draft = getDraft(draftId);
  if (!draft) notFound();

  return (
    <div>
      <Link
        href={`/case/${id}/drafts`}
        className="inline-flex min-h-11 items-center pt-2 text-[15px] text-primary-ink"
      >
        ← 全部文书
      </Link>
      <DraftEditor draft={draft} />
    </div>
  );
}
