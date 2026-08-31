'use client';

import Link from 'next/link';
import { useState } from 'react';
import { demoActions, demoCase, demoDeadlines } from '@/app/_mock/demo';
import type { ActionItem } from '@/app/_mock/types';
import { useDiscreet } from '@/app/_ui/discreet';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Mascot } from '@/components/brand/Mascot';
import { ActionGroup } from '@/components/case/ActionCard';
import { EmptyState } from '@/components/shadcn/empty-state';
import { CaseHeaderBar } from './CaseHeaderBar';
import { DeadlineTiles } from './DeadlineTiles';
import { MilestoneTrack } from './MilestoneTrack';
import { RecentRecords } from './RecentRecords';
import { FULL_JOURNEY, demoAttainments } from './milestones';

/**
 * 驾驶舱：打开应用先回答「我现在该做什么」，不是先给一个空输入框。
 *
 * 三部件的顺序是分量顺序，不是习惯顺序：
 * 时间轴（我在哪）→ 行动卡（该做什么，全页最重）→ 期限（什么时候之前）。
 * 「最近的材料」垫在最后，它是入口不是内容。
 */
export function Dashboard({ caseId }: { caseId: string }) {
  const seeded = caseId === demoCase.id;
  const [actions, setActions] = useState<ActionItem[]>(seeded ? demoActions : []);

  const toggle = (id: string, done: boolean) =>
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: done ? '完成' : '待办' } : a)),
    );

  if (!seeded) return <FirstCase />;

  // 最急的排前面。仲裁时效虽然常驻，但它不该挡在两天后到期的事情前面
  const deadlines = [...demoDeadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const rest = actions.filter((a) => a.status === '待办').length - 1;

  return (
    <div className="pt-1">
      <WatchBar />
      {/* 桌面把轨道并进案由条：横向是桌面多出来的那一维，案由 + 阶段 + 最近期限 + 轨道
          压成一条，省下的高度还给「现在做什么」。**手机一个像素不动**——下面那份轨道
          原样保留，两份互斥显示。
          门开在 `lg`（壳层从底部 Tab 换成侧栏的那一档）：「有没有侧栏」正是案由条要不要
          横排的真变量；案由条**内部**再走容器查询细排（设计红线②：壳层跟设备、工作区内部
          跟可用宽度）。 */}
      <div className="hidden lg:block">
        <CaseHeaderBar caseId={caseId} />
      </div>
      <div className="lg:hidden">
        <MilestoneTrack track={FULL_JOURNEY} attainments={demoAttainments()} />
      </div>
      {/* 只推一件事（产品方案叁）；计数仍是全量，不然「1/5」会缩成「0/1」 */}
      <ActionGroup items={actions} onToggle={toggle} limit={1} />
      {rest > 0 && (
        <p data-veil="" className="mt-1.5 text-[12.5px] text-ink-2">
          其余 <span className="num">{rest}</span> 件排在后面，在
          <Link href={`/case/${caseId}/ask`} className="mx-1 text-primary-ink underline underline-offset-4">
            <NeutralLabel plain="问它" neutral={NEUTRAL_WORD.ask} />
          </Link>
          里能看全。
        </p>
      )}
      <DeadlineTiles deadlines={deadlines} />
      <RecentRecords caseId={caseId} />
    </div>
  );
}

/**
 * 唯一的常驻吉祥物位，小尺寸不抢戏。
 * 低调模式下 `Mascot` 自己返回 null，这里连那句「守望中」也一并收起来——
 * 图没了但字还在，等于换了种方式说同一件事。
 */
function WatchBar() {
  const { discreet } = useDiscreet();
  if (discreet) return null;
  return (
    <div className="flex items-center gap-2 pb-1">
      {/* 56px：实测 52 是「看得清表情」的阈值，取 56 留余量。28px 那档连眼镜都只是一道暗带 */}
      <Mascot pose="watch" size={56} />
      <span className="rounded-full border border-kraft-line bg-kraft px-2.5 py-0.5 text-[12.5px] text-gold-on-kraft">
        土八鼠守望中
      </span>
    </div>
  );
}

/** 还没有案件：递卷宗那张，配一句「说给它听」的入口 */
function FirstCase() {
  return (
    <div className="pt-6">
      <EmptyState
        icon={<Mascot pose="guide" size={148} />}
        title="还没有你的案件"
        description="先把发生了什么说一遍——时间、公司怎么说的、你手里有什么。剩下的顺序它来排。"
        action={
          <Link
            href="/intake"
            className="inline-block rounded-[8px] bg-primary px-5 py-2.5 text-[15px] font-semibold text-on-primary no-underline"
          >
            开始建档
          </Link>
        }
      />
    </div>
  );
}
