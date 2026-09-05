'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { formatDateTime } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { AdviceCard } from './AdviceCard';
import { DocTypeBadge } from './badges';
import { OcrView } from './OcrView';
import { SensitiveText } from './SensitiveText';
import { fetchDoc, toDocDetailView, type ApiDocDetail } from './docsData';

/** 坑的三级 → 给人看的一句话。词表只在这一处，别处要用就引它。 */
const SEVERITY_LABEL: Record<string, string> = {
  must: '必须改',
  strong: '强烈建议改',
  suggest: '建议改',
};

/**
 * 真实案件的一份解读。**只读**。
 *
 * 为什么不复用演示详情页的 DocActions：那张卡上的「加入证据库」是本地 state + 一条成功提示，
 * 什么都不落库。挂在真解读上就是一个会说「已加入」而其实没加的按钮——
 * 用户点完就不会再去传第二遍，而证据库里根本没有这份东西。
 */
export function RealDocView({ caseId, docId }: { caseId: string; docId: string }) {
  const [doc, setDoc] = useState<ApiDocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setMissing(false);
    setDoc(null);
    try {
      setDoc(await fetchDoc(docId));
    } catch (err) {
      // 404 与「这次没读到」是两件事：前者要指路回列表，后者要给重试按钮。
      if (err instanceof Error && /DOC_NOT_FOUND|404/.test(err.message)) setMissing(true);
      else setError(humanError(err));
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这份解读不在这个案件里"
          description="链接可能是旧的，或者它属于另一个案件。回到列表看看现有的几份。"
          action={
            <Button asChild>
              <Link href={`/case/${caseId}/docs`}>回到全部文件</Link>
            </Button>
          }
        />
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这份解读没取出来"
          description={`${error}它还在你的档案里，只是这次没读到。点下面再试一次。`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      </div>
    );
  }
  if (doc === null) {
    return (
      <div className="pt-4">
        <SkeletonList rows={3} />
      </div>
    );
  }
  return <RealDocBody caseId={caseId} doc={doc} />;
}

/** 画法单独一层：不取数、不认 demo，好让「渲染的是不是这份真解读」验得出来 */
export function RealDocBody({ caseId, doc }: { caseId: string; doc: ApiDocDetail }) {
  const view = toDocDetailView(doc);
  const revisePoints = doc.findings
    .map((f) => f.suggestion)
    .filter((s): s is string => s !== null && s.trim().length > 0);

  return (
    <div className="flex flex-col gap-4 pt-1">
      <header className="pt-2">
        <Link
          href={`/case/${caseId}/docs`}
          className="inline-flex min-h-11 items-center fs-m text-primary-ink"
        >
          ← 全部文件
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <DocTypeBadge docType={view.docType} />
          <span className="num fs-xs text-ink-2">解读于 {formatDateTime(view.createdAt)}</span>
        </div>
        <div data-veil="">
          <h1 className="mt-1.5 fs-l font-semibold text-ink">{view.title}</h1>
          <p className="mt-1 fs-s text-ink-2">{view.fileName}</p>
        </div>
      </header>

      <AdviceCard advice={view.advice} detail={view.adviceDetail} revisePoints={revisePoints} />

      {doc.summary && (
        <Card className="p-4">
          <h2 className="fs-m font-semibold text-ink">这份文件说了什么</h2>
          <p data-veil="" className="prose-measure mt-1 fs-m text-ink-2">
            <SensitiveText text={doc.summary} />
          </p>
        </Card>
      )}

      <OcrView ocrText={view.ocrText} riskFlags={view.riskFlags} />

      {doc.findings.length > 0 && (
        <Card className="p-4">
          <h2 className="fs-m font-semibold text-ink">逐条发现</h2>
          <ul className="mt-2 flex flex-col gap-3">
            {doc.findings.map((f) => (
              <li key={f.id} data-veil="" className="border-t border-line pt-3 first:border-0 first:pt-0">
                <p className="fs-m font-medium text-ink">
                  {SEVERITY_LABEL[f.severity] ?? f.severity}｜{f.issue}
                </p>
                {f.clause_ref && (
                  <p className="mt-1 fs-s text-ink-2">原文：<SensitiveText text={f.clause_ref} /></p>
                )}
                {f.basis && <p className="mt-1 fs-s text-ink-2">依据：{f.basis}</p>}
                {f.suggestion && (
                  <p className="mt-1 fs-s text-ink-2">怎么改：<SensitiveText text={f.suggestion} /></p>
                )}
                {f.negotiation_tip && (
                  <p className="mt-1 fs-s text-ink-2">谈的时候：<SensitiveText text={f.negotiation_tip} /></p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="bg-secondary p-4 shadow-none">
        <p className="fs-m text-ink-2">
          对某一条还有疑问，或者想让人帮你把回复的原话写出来，去
          <Link
            href={`/case/${caseId}/ask`}
            className="mx-1 text-primary-ink underline underline-offset-4"
          >
            问它
          </Link>
          接着说。
        </p>
      </Card>
    </div>
  );
}
