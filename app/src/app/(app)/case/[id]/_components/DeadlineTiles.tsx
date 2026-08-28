'use client';

import type { Deadline } from '@/app/_mock/types';
import { cn } from '@/app/_ui/cn';
import { daysUntil, formatDate } from '@/app/_ui/format';
import { Mascot } from '@/components/brand/Mascot';

/** ≤3 天转「愤怒态」。阈值与 DeadlineChip 一致，别在两处各写各的 */
const URGENT_DAYS = 3;

/**
 * 期限倒计时。等宽数字，**大字是天数**——手机上扫一眼要能读到的只有这个。
 *
 * ≤3 天时挂催办姿势的角标。**火冲的是期限，不是用户**（硬禁区①），
 * 所以角标压在「还剩几天」那个数字上，不压在任何跟用户行为有关的东西上。
 *
 * **颜色仍用 amber，不用红**：红在本项目只给风险与不可逆结论（「签/不签」那类），
 * 倒计时借了红，红就贬值了。原型稿那版用的是 seal 红，与同一份稿子里
 * 「红色仍只给风险结论」自相矛盾，此处按已落地的色彩纪律走。
 */
export function DeadlineTiles({ deadlines, now }: { deadlines: Deadline[]; now?: Date }) {
  if (deadlines.length === 0) return null;
  // 角标只挂**最急的那一张**：两只一模一样的土八鼠并排举闹钟，读起来是贴纸不是提示，
  // 而且「哪件最急」这个唯一有用的信息反而被抹平了
  const mostUrgent = deadlines.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
  return (
    <section aria-label="期限倒计时" className="mt-4 grid grid-cols-2 gap-3">
      {deadlines.map((d) => (
        <Tile key={d.id} deadline={d} now={now} badge={d.id === mostUrgent.id} />
      ))}
    </section>
  );
}

function Tile({
  deadline,
  now,
  badge,
}: {
  deadline: Deadline;
  now?: Date;
  badge: boolean;
}) {
  const days = daysUntil(deadline.dueAt, now);
  const urgent = days <= URGENT_DAYS;
  const overdue = days < 0;

  return (
    <div
      data-veil=""
      className={cn(
        'relative rounded-[10px] border px-3 pt-3 pb-2.5 text-center',
        urgent ? 'border-amber bg-amber-wash' : 'border-line bg-surface',
      )}
    >
      {urgent && badge && (
        /* 挂**左**上角而不是右上角：右上角正对着栅格间隙，两张卡挨着时
           读者分不清这只土八鼠在替哪一张着急。左上角贴着最急那张的外沿，没有歧义。 */
        <Mascot pose="nag" size={32} className="absolute -top-3.5 -left-2" />
      )}
      <div
        className={cn(
          'num text-[26px] leading-8 font-bold',
          urgent ? 'text-amber-ink' : 'text-ink',
        )}
      >
        {overdue ? '已过' : days}
      </div>
      <div className={cn('text-[11px] leading-4', urgent ? 'text-amber-ink' : 'text-ink-2')}>
        {overdue ? '期限已过' : '天'}
      </div>
      <div className="mt-1 text-[12px] leading-4 text-ink-2">{deadline.title}</div>
      <div className="num mt-0.5 text-[11px] leading-4 text-ink-2">
        {formatDate(deadline.dueAt)}
      </div>
    </div>
  );
}
