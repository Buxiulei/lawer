'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { demoCase } from '@/app/_mock/demo';
import type { ActionItem } from '@/app/_mock/types';

import { useDiscreet } from '@/app/_ui/discreet';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Mascot } from '@/components/brand/Mascot';
import { ActionGroup } from '@/components/case/ActionCard';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { useEnterStagger } from '@/hooks/useEnterStagger';
import { DeadlineTiles } from './DeadlineTiles';
import { MilestoneTrack } from './MilestoneTrack';
import { RecentRecords } from './RecentRecords';
import { FULL_JOURNEY } from './milestones';
import {
  demoDashboard,
  failureOf,
  fetchDashboard,
  saveActionStatus,
  viewState,
  type DashboardData,
  type LoadFailure,
} from './dashboardData';

/**
 * 驾驶舱：打开应用先回答「我现在该做什么」，不是先给一个空输入框。
 *
 * 三部件的顺序是分量顺序，不是习惯顺序：
 * 时间轴（我在哪）→ 行动卡（该做什么，全页最重）→ 期限（什么时候之前）。
 * 「最近的材料」垫在最后，它是入口不是内容。
 *
 * 【数据从哪来】演示案件走 mock，其余一律现查接口（见 dashboardData）。
 * 这里曾经只认字面量 demo，真实案件一律渲染「还没有你的案件」——
 * 库里有整套数据，页面从没去取过。
 */
export function Dashboard({ caseId }: { caseId: string }) {
  const isDemo = caseId === demoCase.id;
  const [data, setData] = useState<DashboardData | null>(isDemo ? demoDashboard(caseId) : null);
  const [error, setError] = useState<LoadFailure | null>(null);

  const load = useCallback(async () => {
    if (isDemo) {
      setData(demoDashboard(caseId));
      return;
    }
    setError(null);
    setData(null);
    try {
      setData(await fetchDashboard(caseId));
    } catch (err) {
      setError(failureOf(err));
    }
  }, [caseId, isDemo]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 勾选先落本地再发请求：这一格的手感必须是即时的。
   * 但**失败要翻回去**——勾上了却没存下，用户下次打开发现又变回待办，
   * 那比当场说一句"没存上"难受得多，而且他不会知道是哪一步丢的。
   */
  const toggle = useCallback(
    (id: string, done: boolean) => {
      const apply = (status: ActionItem['status']) =>
        setData((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                actions: prev.actions.map((a) => (a.id === id ? { ...a, status } : a)),
              },
        );
      apply(done ? '完成' : '待办');
      if (isDemo) return;
      void saveActionStatus(caseId, id, done).catch((err) => {
        apply(done ? '待办' : '完成');
        setError(failureOf(err));
      });
    },
    [caseId, isDemo],
  );

  const state = viewState({ error, data });
  if (state === 'missing') return <CaseMissing />;
  if (state === 'failed') return <LoadFailed message={error?.message ?? ''} onRetry={() => void load()} />;
  if (state === 'loading' || data === null) return <Loading />;
  if (state === 'blank') return <FirstCase />;

  return <DashboardBody caseId={caseId} data={data} onToggle={toggle} />;
}

/**
 * 拿到数据之后怎么画。**只吃传进来的 data**，自己不取数、不认 demo——
 * 分出来是为了让「四块到底有没有接上真数据」在 node 环境里就能验：
 * 取数那半截要跑 effect（SSR 到不了），这半截不用。
 */
export function DashboardBody({
  caseId,
  data,
  onToggle,
}: {
  caseId: string;
  data: DashboardData;
  onToggle?: (id: string, done: boolean) => void;
}) {
  // 最急的排前面。仲裁时效虽然常驻，但它不该挡在两天后到期的事情前面
  const deadlines = [...data.deadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const rest = data.actions.filter((a) => a.status === '待办').length - 1;
  /* 入场 stagger 只挂 `data-mo-enter` 点名的那几块（A7）。渲染层持有 root，取数层（Dashboard）不碰。
     **行动卡那一组刻意不在里面**：它自己已经有 `mo-fade-in`（对话流里也要用那一条），
     两层入场叠在同一个元素上会看见「淡进来又被按下去一次」。 */
  const root = useRef<HTMLDivElement>(null);
  useEnterStagger(root, { selector: '[data-mo-enter]' });

  return (
    <div ref={root} className="pt-1">
      <WatchBar />
      {/* 【批6-B 桌面案由条 CaseHeaderBar 暂不挂回，待接真数据】
          ws-panels 的 CaseHeaderBar 现在取的是 demo 数据（demoCase.title/stage/demoDeadlines），
          挂在真实案件页会让 PC 用户在自己案件顶栏读到「星曜网络」——正是 mycase 红线
          (dashboard-real-data.test「没有任何演示痕迹」) 守的那个用户亲报痛点。故此处**不挂**，
          轨道对全断点仍是这一份 MilestoneTrack。待 CaseHeaderBar 接真数据
          （同 layout.tsx 恒传 demoCase.title 那条遗留的同族纯接线小单，manager 已排）后：
          把这份 MilestoneTrack 收成 `lg:hidden`、桌面切到 `<CaseHeaderBar caseId={caseId} />`。
          CaseHeaderBar 组件与它的测试已合入本仓，只差挂回这一步。 */}
      <div data-mo-enter>
        <MilestoneTrack track={FULL_JOURNEY} attainments={data.attainments} />
      </div>
      {/* 只推一件事（产品方案叁）；计数仍是全量，不然「1/5」会缩成「0/1」。
          `collapseOnDone`：勾完这一件它让开，下一件才有地方站——
          「完成庆祝」的正确形态是下一件事出现，不是彩带。 */}
      <ActionGroup items={data.actions} onToggle={onToggle} limit={1} collapseOnDone />
      {rest > 0 && (
        <p data-veil="" className="mt-1.5 text-[12.5px] text-ink-2">
          其余 <span className="num">{rest}</span> 件排在后面，在
          {/* 这条行内链接实测 25×14，**有意不补到 44**：它是句子里的一个词，
              撑成 44px 会把这行说明拆成阶梯状；误点的代价只是跳到问它页、退回来即可。
              决策见审查台账 P-03。同页的底部 Tab 与行动卡都已达标，这不是漏网。 */}
          <Link href={`/case/${caseId}/ask`} className="mx-1 text-primary-ink underline underline-offset-4">
            <NeutralLabel plain="问它" neutral={NEUTRAL_WORD.ask} />
          </Link>
          里能看全。
        </p>
      )}
      <DeadlineTiles deadlines={deadlines} />
      <DossierEntry caseId={caseId} />
      <div data-mo-enter>
        <RecentRecords caseId={caseId} records={data.records} />
      </div>
    </div>
  );
}

/**
 * 公司档案的入口。**先免费查有没有货**：这家公司被仲裁过多少次、赔没赔、有没有关联主体，
 * 决定了谈判时敢不敢硬、以及把谁列成被申请人。
 *
 * 【为什么摆在驾驶舱而不是加一个底部 Tab】底部导航是全站最贵的四个位置，
 * 加第五个会把每一个都挤窄；而这件事是**案件里的一步**，不是一个常驻场所。
 * 在此之前它没有任何入口：功能整套做好了，用户找不到门。
 */
function DossierEntry({ caseId }: { caseId: string }) {
  return (
    <Link
      href={`/case/${caseId}/dossier`}
      data-mo-enter
      className="mt-4 flex min-h-11 items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 py-3 no-underline"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-6 font-medium text-ink">
          公司档案：先免费查有没有货
        </span>
        <span className="mt-0.5 block text-[13px] leading-5 text-ink-2">
          这家公司被仲裁过几次、赔没赔、有没有关联主体——免费的那部分先看着。
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-[15px] text-ink-2">
        ›
      </span>
    </Link>
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
    <div data-mo-enter className="flex items-center gap-2 pb-1">
      {/* 56px：实测 52 是「看得清表情」的阈值，取 56 留余量。28px 那档连眼镜都只是一道暗带 */}
      <Mascot pose="watch" size={56} />
      <span className="rounded-full border border-kraft-line bg-kraft px-2.5 py-0.5 text-[12.5px] text-gold-on-kraft">
        土八鼠守望中
      </span>
    </div>
  );
}

/** 取数中。不先画 FirstCase 再换掉——那会让每次进页面都闪一句「还没有你的案件」 */
function Loading() {
  return (
    <div className="pt-4">
      <SkeletonList rows={4} />
    </div>
  );
}

/**
 * 没取到。**这里绝不能退回 FirstCase**：「查不到」和「确实没有」在这一页上
 * 长得一模一样，而它俩差着用户全部的记录。宁可停下来说清楚。
 */
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="pt-6">
      <EmptyState
        title="这一屏没取出来"
        description={`${message}你的案件和材料都还在，只是这次没读到。点下面再试一次。`}
        action={<Button onClick={onRetry}>重试</Button>}
      />
    </div>
  );
}

/**
 * 这个案件不存在，或者不是你的。**终局，不给重试**。
 *
 * 【为什么单开一种，而不是并进「这一屏没取出来」】那一屏写着「你的案件和材料都还在，
 * 只是这次没读到。点下面再试一次」——对着一个**根本不属于他的案件号**说这句话，
 * 每个字都是错的：材料不是他的，重试一万次也一样。用户实测读到的是
 * 「案件不存在你的案件和材料都还在」，两句话粘在一起，前后自相矛盾。
 *
 * 【为什么不解释是"不存在"还是"不属于你"】后端刻意让两者同码（lib/cases 的红线）：
 * 区分开就等于承认这个案件号是有效的，攻击者靠遍历 id 就能数出平台有多少案件。
 * 所以这一页也只能说到这儿，并把人送回他自己的案件。
 */
export function CaseMissing() {
  return (
    <div className="pt-6">
      <EmptyState
        title="这个案件不存在或不属于你"
        description="地址里的案件号在你名下查不到。可能是链接过期、复制串了，或者这本来是别人的案件。"
        action={
          <Link
            href="/case"
            className="inline-block rounded-[8px] bg-primary px-5 py-2.5 text-[15px] font-semibold text-on-primary no-underline"
          >
            回我的案件
          </Link>
        }
      />
    </div>
  );
}

/** 案件建了但里面还是空的：递卷宗那张，配一句「说给它听」的入口 */
function FirstCase() {
  return (
    <div className="pt-6">
      <EmptyState
        icon={<Mascot pose="guide" size={148} />}
        title="这个案件还是空的"
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
