'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { AnnotatedDoc } from '@/app/_mock/docs-drafts';
import { cn } from '@/app/_ui/cn';
import { formatDate } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { ADVICE_INK, DocTypeBadge, RiskCountBadge } from './badges';
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
          <h1 className="fs-xl font-semibold text-ink">文件解读</h1>
          <p className="fs-s mt-0.5 text-ink-2">
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
                  className="overflow-hidden p-0 transition-colors duration-150 ease-out group-hover:bg-muted"
                >
                  {/* 标题栏：**结论是整张卡里最大的字**。
                      此前它是三个同权重徽标之一（类型 / 结论 / N 处标红），
                      而「签不签」才是用户翻这一页要找的东西。 */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
                    <span className={cn('fs-l font-semibold', ADVICE_INK[doc.advice])}>
                      {doc.advice}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <DocTypeBadge docType={doc.docType} />
                      <RiskCountBadge count={doc.riskFlags.length} />
                    </span>
                  </div>

                  <div className="px-4 py-3">
                    <h2 className="fs-m font-semibold text-ink">{doc.title}</h2>
                    <p className="fs-s mt-1 line-clamp-2 text-ink-2">
                      <SensitiveText text={doc.adviceDetail} />
                    </p>
                    <p className="num fs-xs mt-2 text-ink-2">
                      {formatDate(doc.createdAt)} · {doc.fileName}
                    </p>
                  </div>
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
