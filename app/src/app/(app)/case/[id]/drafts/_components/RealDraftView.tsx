'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { formatDateTime } from '@/app/_ui/format';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { DraftKindBadge, DraftStatusBadge } from './badges';
import { fetchDrafts, findDraft, type DraftView } from './draftsData';

/**
 * 真实案件的一份文书。**只读**。
 *
 * 为什么不复用 DraftEditor：那个编辑器的「保存」「恢复这一版」「标记已发送」全是本地 state，
 * 演示案件里这样没问题（本来就是演示），换到真实文书上就是一个会说「已保存」但什么都没存的按钮——
 * 用户改完措辞、看见成功提示、关掉页面，改动全没了。在有写接口之前，只读是唯一诚实的形态。
 */
export function RealDraftView({ caseId, draftId }: { caseId: string; draftId: string }) {
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
          title="这份文书没取出来"
          description={`${error}它还在你的档案里，只是这次没读到。点下面再试一次。`}
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

  const draft = findDraft(drafts, draftId);
  if (!draft) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这份文书不在这个案件里"
          description="链接可能是旧的，或者这份文书属于另一个案件。回到列表看看现有的几份。"
          action={
            <Button asChild>
              <Link href={`/case/${caseId}/drafts`}>回到全部文书</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <RealDraftBody caseId={caseId} draft={draft} />;
}

/** 画法单独一层：不取数、不认 demo，好让「渲染的是不是这份真文书」验得出来 */
export function RealDraftBody({ caseId, draft }: { caseId: string; draft: DraftView }) {
  return (
    <div className="flex flex-col gap-4 pt-1">
      <header className="pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <DraftKindBadge kind={draft.kind} />
          <DraftStatusBadge status={draft.status} />
          <span className="num text-[13px] text-ink-2">
            v{draft.version} · 更新于 {formatDateTime(draft.updatedAt)}
          </span>
        </div>
        <h1 data-veil="" className="mt-1.5 text-[22px] leading-8 font-semibold text-ink">
          {draft.title}
        </h1>
      </header>

      {/* 正文整篇都是公司名、金额和主张：低调模式下整块糊着 */}
      <pre
        data-veil=""
        className="font-sans text-[16px] leading-8 whitespace-pre-wrap text-ink"
      >
        {draft.content}
      </pre>

      <Card className="bg-secondary p-4 shadow-none">
        <p className="text-[15px] leading-7 text-ink-2">
          这一页现在只能读，改不了。要改哪一句、要另起一版，去
          <Link
            href={`/case/${caseId}/ask`}
            className="mx-1 text-primary-ink underline underline-offset-4"
          >
            <NeutralLabel plain="问它" neutral={NEUTRAL_WORD.ask} />
          </Link>
          说清楚，它会重写一份存进来，旧的那版也留着。
        </p>
      </Card>
    </div>
  );
}
