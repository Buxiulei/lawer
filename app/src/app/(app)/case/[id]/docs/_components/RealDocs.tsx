'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AnnotatedDoc } from '@/app/_mock/docs-drafts';
import { humanError } from '@/app/_ui/api';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { DocsEmpty } from './DocsEmpty';
import { DocsListView } from './DocsListView';
import { fetchDocs } from './docsData';

/**
 * 真实案件的文件解读页。取数在这里，画法交给 DocsListView（与演示案件同一份画法）。
 *
 * 三种屏幕分得清清楚楚：取数中（骨架）、没取到（说清楚 + 重试）、确实没有（DocsEmpty 空态）。
 * **没取到绝不能画成空态**：两者在屏幕上都是一片什么都没有，
 * 但把前者画成后者，等于对一个确实解读过几份文件的人说「你还没有解读过文件」。
 *
 * 【为什么真实案件不给「上传文件」】同目录的 UploadSheet 是演示件：它跑四步假进度、
 * 不落文件，最后把人送到样张 cd_2。今天的解读入口是对话里的 agent（doc_submit），
 * 网页这一页是展示层。等真上传通路接上再把按钮放回来。
 */
export function RealDocs({ caseId }: { caseId: string }) {
  const [docs, setDocs] = useState<AnnotatedDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setDocs(null);
    try {
      setDocs(await fetchDocs(caseId));
    } catch (err) {
      setError(humanError(err));
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这一页没取出来"
          description={`${error}解读结果都还在，只是这次没读到。点下面再试一次。`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      </div>
    );
  }
  if (docs === null) {
    return (
      <div className="pt-4">
        <SkeletonList rows={3} />
      </div>
    );
  }
  if (docs.length === 0) return <DocsEmpty caseId={caseId} />;
  return <DocsListView caseId={caseId} docs={docs} canUpload={false} />;
}
