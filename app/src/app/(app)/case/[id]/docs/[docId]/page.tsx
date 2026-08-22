import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDoc, revisePointsByDoc } from '@/app/_mock/docs-drafts';
import { formatDateTime } from '@/app/_ui/format';
import { AdviceCard } from '../_components/AdviceCard';
import { DocActions } from '../_components/DocActions';
import { DocTypeBadge } from '../_components/badges';
import { OcrView } from '../_components/OcrView';

export const metadata: Metadata = { title: '文件解读' };

export default async function DocDetailPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  const doc = getDoc(docId);
  if (!doc) notFound();

  return (
    <div className="flex flex-col gap-4 pt-1">
      <header className="pt-2">
        <Link
          href={`/case/${id}/docs`}
          className="inline-flex min-h-11 items-center text-[15px] text-primary-ink"
        >
          ← 全部文件
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <DocTypeBadge docType={doc.docType} />
          <span className="num text-[13px] text-ink-2">
            解读于 {formatDateTime(doc.createdAt)}
          </span>
        </div>
        <div data-veil="">
          <h1 className="mt-1.5 text-[22px] leading-8 font-semibold text-ink">{doc.title}</h1>
          <p className="mt-1 text-[14px] text-ink-2">{doc.fileName}</p>
        </div>
      </header>

      <AdviceCard
        advice={doc.advice}
        detail={doc.adviceDetail}
        revisePoints={revisePointsByDoc[doc.id]}
      />

      <OcrView ocrText={doc.ocrText} riskFlags={doc.riskFlags} />

      <DocActions caseId={id} docTitle={doc.title} />
    </div>
  );
}
