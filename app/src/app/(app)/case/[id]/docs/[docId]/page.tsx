import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { demoCase } from '@/app/_mock/demo';
import { getDoc, revisePointsByDoc } from '@/app/_mock/docs-drafts';
import { formatDateTime } from '@/app/_ui/format';
import { AdviceCard } from '../_components/AdviceCard';
import { DocActions } from '../_components/DocActions';
import { DocTypeBadge } from '../_components/badges';
import { OcrView } from '../_components/OcrView';
import { RealDocView } from '../_components/RealDocView';

export const metadata: Metadata = { title: '文件解读' };

export default async function DocDetailPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  // 样张只属于演示案件。真实案件下 cd_* 一律 404，而不是把别家公司的解除通知
  // 摆到用户自己的档案里——那正是「上传文件」那条演示流水线会把人送到的地址。
  if (id !== demoCase.id) {
    // 真实解读的 id 是库里的自增整数；`cd_2` 这类演示 id 在真实案件下仍然 404。
    if (!/^\d+$/.test(docId)) notFound();
    return <RealDocView caseId={id} docId={docId} />;
  }
  const doc = getDoc(docId);
  if (!doc) notFound();

  return (
    <div className="flex flex-col gap-4 pt-1">
      <header className="pt-2">
        <Link
          href={`/case/${id}/docs`}
          className="inline-flex min-h-11 items-center fs-m text-primary-ink"
        >
          ← 全部文件
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <DocTypeBadge docType={doc.docType} />
          <span className="num fs-xs text-ink-2">
            解读于 {formatDateTime(doc.createdAt)}
          </span>
        </div>
        <div data-veil="">
          <h1 className="mt-1.5 fs-l font-semibold text-ink">{doc.title}</h1>
          <p className="mt-1 fs-s text-ink-2">{doc.fileName}</p>
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
