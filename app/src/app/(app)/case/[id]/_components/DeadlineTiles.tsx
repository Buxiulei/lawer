'use client';

import { useEffect, useRef, useState } from 'react';
import type { Deadline } from '@/app/_mock/types';
import { cn } from '@/app/_ui/cn';
import { daysUntil, formatDate } from '@/app/_ui/format';
import { Mascot } from '@/components/brand/Mascot';
import { useEnterStagger } from '@/hooks/useEnterStagger';

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
 *
 * 【动效：克制到没有常驻动效】**无限脉动否决**，三条理由：
 * ① 全站无限循环的名额只有一个，已经给了里程碑那一格的呼吸环；
 * ② 「绝不红底闪烁」是已裁的口径，脉动是闪烁的连续版；
 * ③ 它常驻首屏，代价是永久的合成层 + **永久的注意力税**。
 * 代之以三个离散时刻：首次进入视野、跨过阈值那一刻、天数变化。
 * **已过期不加任何动效**——过期是既成事实，动效改变不了它，只会让人更慌。
 */
export function DeadlineTiles({ deadlines, now }: { deadlines: Deadline[]; now?: Date }) {
  const root = useRef<HTMLElement>(null);
  // 最急那张最后到（`from: 'end'`），视线跟着停在它身上。每次冷启动只播一次
  useEnterStagger(root, { selector: '[data-mo-tile]', y: 8, each: 60, from: 'end', inView: true });
  useForegroundTick();

  if (deadlines.length === 0) return null;
  // 角标只挂**最急的那一张**：两只一模一样的土八鼠并排举闹钟，读起来是贴纸不是提示，
  // 而且「哪件最急」这个唯一有用的信息反而被抹平了
  const mostUrgent = deadlines.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
  return (
    <section ref={root} aria-label="期限倒计时" className="mt-4 grid grid-cols-2 gap-3">
      {deadlines.map((d) => (
        <Tile key={d.id} deadline={d} now={now} badge={d.id === mostUrgent.id} />
      ))}
    </section>
  );
}

/**
 * 回到前台时重算一次天数。
 *
 * 没有这一下，「跨过 ≤3 天阈值那一刻」这个时刻**在真实使用里几乎永远不会发生**：
 * 用户昨晚把页面留在后台，今天早上拿起来看到的还是昨天的数字，
 * 页面既不报错也不刷新——又一例「产物看起来完全正常」。
 */
function useForegroundTick() {
  const [, bump] = useState(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
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
  // 本会话内**刚刚**跨过阈值的那一张才亮一下。挂载时就已经紧急的不闪——
  // 那不是「刚发生的事」，是既成事实（同里程碑「首屏不补播」那条）
  const justCrossed = useJustTurnedTrue(urgent && !overdue);

  return (
    <div
      data-veil=""
      data-mo-tile=""
      className={cn(
        /* 底色与边框的过渡走 token；**天数数字直接换，不做翻牌轮** */
        'mo-track-tint relative rounded-[10px] border px-3 pt-3 pb-2.5 text-center',
        urgent ? 'border-amber bg-amber-wash' : 'border-line bg-surface',
      )}
    >
      {urgent && badge && (
        /* 挂**左**上角而不是右上角：右上角正对着栅格间隙，两张卡挨着时
           读者分不清这只土八鼠在替哪一张着急。左上角贴着最急那张的外沿，没有歧义。 */
        <Mascot
          pose="nag"
          size={48}
          className={cn('absolute -top-5 -left-3', justCrossed && 'mo-nag-in')}
        />
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

/** 值由 false 翻成 true 的那一次返回 true；挂载时就是 true 的不算 */
function useJustTurnedTrue(value: boolean): boolean {
  const prev = useRef(value);
  const [fired, setFired] = useState(false);
  useEffect(() => {
    if (value && !prev.current) setFired(true);
    prev.current = value;
  }, [value]);
  return fired;
}
