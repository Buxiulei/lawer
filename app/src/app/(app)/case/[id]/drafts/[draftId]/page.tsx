import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { demoCase } from '@/app/_mock/demo';
import { getDraft } from '@/app/_mock/docs-drafts';
import { DraftEditor } from '../_components/DraftEditor';
import { RealDraftView } from '../_components/RealDraftView';

export const metadata: Metadata = { title: '文书' };

/**
 * 演示案件走 mock（可编辑的那一版是演示，改动本来就不落库）；
 * 真实案件按 caseId 现查自己的文书，只读。mock 的 dr_* 在真实案件下**不认**——
 * 拿演示 id 拼出来的链接不该在别人的案子里渲染出别家公司的文书。
 */
export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ id: string; draftId: string }>;
}) {
  const { id, draftId } = await params;
  const isDemo = id === demoCase.id;
  const draft = isDemo ? getDraft(draftId) : undefined;
  if (isDemo && !draft) notFound();

  return (
    <div>
      <Link
        href={`/case/${id}/drafts`}
        className="inline-flex min-h-11 items-center pt-2 text-[15px] text-primary-ink"
      >
        ← 全部文书
      </Link>
      {draft ? <DraftEditor draft={draft} /> : <RealDraftView caseId={id} draftId={draftId} />}
    </div>
  );
}
