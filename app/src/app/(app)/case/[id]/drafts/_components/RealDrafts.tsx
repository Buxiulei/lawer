'use client';

import { useCallback, useEffect, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { DraftsListView } from './DraftsListView';
import { fetchDrafts, type DraftView } from './draftsData';

/**
 * 真实案件的文书页。取数在这里，画法全交给 DraftsListView。
 *
 * 三种屏幕分得清清楚楚：取数中（骨架）、没取到（说清楚 + 重试）、确实没有（空态 + 引导）。
 * **没取到绝不能画成空态**：两者在屏幕上都是「一片什么都没有」，
 * 但把前者画成后者，等于对一个名下确实有文书的人说「你还没有文书」。
 */
export function RealDrafts({ caseId }: { caseId: string }) {
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setDrafts(null);
    try {
      setDrafts(await fetchDrafts(caseId));
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
          description={`${error}你的文书都还在，只是这次没读到。点下面再试一次。`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      </div>
    );
  }
  if (drafts === null) {
    return (
      <div className="pt-4">
        <SkeletonList rows={3} />
      </div>
    );
  }
  return <DraftsListView caseId={caseId} drafts={drafts} />;
}
