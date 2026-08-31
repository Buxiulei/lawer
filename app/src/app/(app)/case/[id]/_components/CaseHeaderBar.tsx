'use client';

import { useCallback, useState } from 'react';
import { demoCase, demoDeadlines } from '@/app/_mock/demo';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import { Badge } from '@/components/shadcn/badge';
import { CommandSearch, useCommandSearchHotkey } from './CommandSearch';
import { MilestoneTrack } from './MilestoneTrack';
import { FULL_JOURNEY, demoAttainments } from './milestones';

/**
 * 案由条（设计 §二）：案由 + 阶段 + 最近期限 + **横置的里程碑轨道** + ⌘K 入口。
 *
 * 横向是桌面多出来的那一维——手机上里程碑轨道得自己占一整段高度，
 * 桌面上它可以贴着案由躺成一条，把省下的高度还给「现在做什么」。
 *
 * 【断点量的是内容区宽度，不是视口】设计红线②：这一条挂 `@container/work`，
 * 里面的重排全走容器查询。侧栏一收、主区变宽，案由条自己就从两行变一行，
 * 视口一个像素没动——媒体查询做不出这件事。
 *
 * 【四态判据不动】轨道直接复用 `MilestoneTrack`：四态靠格子下面那行字区分，
 * 不靠颜色、不靠长度（设计 §二）。桌面只是让它更宽，判据一字不改。
 */
export function CaseHeaderBar({ caseId }: { caseId: string }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useCommandSearchHotkey(openSearch);

  const nearest = [...demoDeadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];

  return (
    <section
      aria-label="案由与进度"
      className="@container/work mb-4 rounded-[12px] border border-line bg-surface px-4 pt-3 pb-2"
    >
      <div className="flex flex-col gap-2 @[720px]/work:flex-row @[720px]/work:items-center @[720px]/work:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {/* 案由本身就是「哪家公司 · 什么事」，低调模式下整块进糊层 */}
          <h2 data-veil="" className="min-w-0 truncate fs-l font-semibold text-ink">
            {demoCase.title}
          </h2>
          <span data-veil="" className="inline-flex">
            <Badge tone="primary">{demoCase.stage}</Badge>
          </span>
          {nearest && <DeadlineChip dueAt={nearest.dueAt} showDate />}
        </div>

        <button
          type="button"
          onClick={openSearch}
          className="flex shrink-0 items-center gap-2 rounded-[8px] border border-line px-2.5 py-1.5 text-left fs-s text-ink-2 transition-colors duration-150 ease-out hover:bg-surface-2"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="6.2" />
            <path d="M15.6 15.6 20 20" />
          </svg>
          跳到…
          {/* kbd 在窄容器里先让位：它是提示，不是入口 */}
          <kbd className="num hidden rounded-[4px] border border-line px-1.5 py-0.5 fs-xs @[720px]/work:inline">
            ⌘K
          </kbd>
        </button>
      </div>

      <MilestoneTrack track={FULL_JOURNEY} attainments={demoAttainments()} />

      <CommandSearch caseId={caseId} open={searchOpen} onOpenChange={setSearchOpen} />
    </section>
  );
}
