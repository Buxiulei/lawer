'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { AnnotatedDoc } from '@/app/_mock/docs-drafts';
import { formatDate } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { AdviceBadge, DocTypeBadge, RiskCountBadge } from './badges';
import { SensitiveText } from './SensitiveText';
import { UploadSheet } from './UploadSheet';

export function DocsListView({
  caseId,
  docs,
}: {
  caseId: string;
  docs: AnnotatedDoc[];
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const closeUpload = useCallback(() => setUploadOpen(false), []);

  return (
    <div className="pt-1">
      <header className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">文件解读</h1>
          <p className="mt-0.5 text-[15px] leading-7 text-ink-2">
            公司让你签的东西，先传上来看清楚再决定。
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>上传文件</Button>
      </header>

      {docs.length === 0 ? (
        <EmptyState
          title="还没有解读过的文件"
          description="把解除通知、协商协议或者调岗通知拍下来传上去，几十秒后你会拿到标红的原文和签不签的结论。"
          action={<Button onClick={() => setUploadOpen(true)}>上传第一份文件</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Link href={`/case/${caseId}/docs/${doc.id}`} className="group block">
                <Card
                  data-veil=""
                  className="p-4 transition-colors duration-150 ease-out group-hover:bg-muted"
                >
                <div className="flex flex-wrap items-center gap-2">
                  <DocTypeBadge docType={doc.docType} />
                  <AdviceBadge advice={doc.advice} />
                  <RiskCountBadge count={doc.riskFlags.length} />
                </div>

                <h2 className="mt-2 text-[17px] leading-7 font-semibold text-ink">
                  {doc.title}
                </h2>
                <p className="mt-1 line-clamp-2 text-[15px] leading-7 text-ink-2">
                  <SensitiveText text={doc.adviceDetail} />
                </p>

                <p className="num mt-2 text-[13px] text-ink-2">
                  {formatDate(doc.createdAt)} · {doc.fileName}
                </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <UploadSheet open={uploadOpen} onClose={closeUpload} caseId={caseId} />
    </div>
  );
}
