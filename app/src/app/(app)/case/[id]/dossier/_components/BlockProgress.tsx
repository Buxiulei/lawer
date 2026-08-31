'use client';

import type { DossierBlock } from '@/lib/dossier/contract';
import { BLOCK_LABEL, BLOCK_STATE_LABEL } from '@/lib/dossier/present';
import { formatDate } from '@/app/_ui/format';
import { Badge } from '@/components/shadcn/badge';

const TONE: Record<string, 'neutral' | 'primary' | 'success' | 'amber' | 'danger'> = {
  queued: 'neutral',
  running: 'primary',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
  expired: 'amber',
};

/**
 * 分块进度。
 *
 * 【为什么按块列而不是给一根总进度条】档案是**分块交付**的：谱系几分钟就有，
 * 判例要等外勤开窗（最长若干个工作日）。一根总进度条会把"谱系已经能看了"
 * 这件事藏起来，让人以为什么都还没有。
 *
 * 【失败必须占一行】跑失败的块留在列表里、带着原因，不从界面上消失——
 * 静默失效是本产品最危险的失败模式（同 company_watch_checks.ok=0 必须留行的规矩）。
 */
export function BlockProgress({
  blocks,
  queuePosition,
}: {
  blocks: DossierBlock[];
  queuePosition: number | null;
}) {
  return (
    <section>
      <ul className="flex flex-col gap-2">
        {blocks.map((b) => (
          <li
            key={b.block}
            data-veil=""
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-border bg-card px-3 py-2.5"
          >
            <span className="text-[15px] leading-7 font-medium text-ink">
              {BLOCK_LABEL[b.block] ?? b.block}
            </span>
            <Badge tone={TONE[b.state] ?? 'neutral'}>
              {BLOCK_STATE_LABEL[b.state] ?? b.state}
            </Badge>
            {b.finishedAt && (
              <span className="num text-[12.5px] text-ink-2">{formatDate(b.finishedAt)}</span>
            )}
            {/* 失败原因照后端给的三段式原样显示：缺什么 / 为什么缺 / 怎么办。
                在这里改写或截断，等于把"怎么办"那一段删掉。 */}
            {b.errorText && (
              <p className="prose-measure w-full text-[13px] leading-6 text-ink-2">
                {b.errorText}
              </p>
            )}
          </li>
        ))}
      </ul>
      {queuePosition !== null && (
        <p data-veil="" className="mt-2 text-[13px] leading-6 text-ink-2">
          判例采集在队列里排第 <span className="num">{queuePosition}</span> 位。
          这一步要真人登录取证，排队快慢不由服务器决定。
        </p>
      )}
    </section>
  );
}
