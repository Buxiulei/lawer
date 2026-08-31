'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import { fetchMyCases, writeCachedCaseId } from '@/app/_ui/currentCase';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { destinationFor, latestOf, type Outcome } from './resolve';

/**
 * 过路页：查一次 GET /api/v1/cases，把人送进他自己的案件。
 *
 * 跳转用 replace 不用 push：这一页不该出现在返回栈里，
 * 否则用户在案件里按返回会被这一页再送回案件，退不出去。
 */
export function CaseResolver() {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    setFailure(null);
    if (readToken() === null) {
      setOutcome({ kind: 'signed-out' });
      return;
    }
    try {
      const cases = await fetchMyCases();
      const latest = latestOf(cases);
      if (latest) writeCachedCaseId(latest.id);
      setOutcome({ kind: 'cases', cases });
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'UNAUTHORIZED') {
        setOutcome({ kind: 'unauthorized' });
        return;
      }
      setFailure(humanError(err));
      setOutcome({ kind: 'failed' });
    }
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const destination = outcome === null ? null : destinationFor(outcome);

  useEffect(() => {
    if (destination?.href) router.replace(destination.href);
  }, [destination?.href, router]);

  if (destination && destination.href === null) {
    return (
      <div className="pt-6">
        <EmptyState
          title={destination.notice}
          // 自述三段式：缺什么 / 为什么缺 / 怎么办。只甩一句「加载失败」等于让用户
          // 把我刚推过的那一遍再推一遍。
          description={`${failure ?? '接口这次没响应。'}你的案件和材料都还在，只是这次没查到它在哪儿。网络恢复后点下面重试；一直不行就直接从「我的」进去。`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => void resolve()}>重试</Button>
              <Button variant="secondary" onClick={() => router.replace('/account')}>
                去「我的」
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <p className="pt-10 text-center text-[15px] text-ink-2">
      {destination?.notice ?? '正在打开你的案件…'}
    </p>
  );
}
