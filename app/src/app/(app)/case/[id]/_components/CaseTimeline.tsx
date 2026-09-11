'use client';

import { useCallback, useEffect, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { useCaseDomain } from '@/app/_ui/caseDomain';
import { cn } from '@/app/_ui/cn';
import { packOf } from '@/app/_ui/domain';
import { formatDate } from '@/app/_ui/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { tierMark } from '@/lib/cases/source-tier';
import { evidenceCiteId } from './citations';
import { MaskedText } from './RichText';
import { AddEventSheet, PickTypeSheet } from './TimelineEntrySheet';
import {
  demoEvents,
  fetchTimeline,
  prependEvent,
  replaceEvent,
  type TimelineEventView,
} from './timelineData';

/**
 * 卷宗栏的时间线：这个案子按日子发生过什么，外加「记一件事」这个登记入口。
 *
 * 【这一块此前渲染的是演示数据】caseId 传进来却一次都没被用来取数，二十条写死的
 * 演示事件对每一个案件都照样渲染——与 RecentRecords / Dashboard 当年那个形态同款：
 * 页面不报错、条数也对，只是打开它的人看到的每一条都不是自己的事。
 * 取数与 demo 适配都收在 ./timelineData，本文件一个 `_mock` 都不 import。
 *
 * 【为什么登记入口长在这里，而不是另开一页】用户想记一件事的那一刻，正是他在看
 * 时间线、发现某一天空着的那一刻。把入口放到别处，等于让他先记住"我要去哪儿记"。
 */

/** 四类事件的色点。认不出的类别落中性色——不折成四类里的某一档（见 timelineData.toTimelineView）。 */
const KIND_DOT: Record<string, string> = {
  公司动作: 'bg-amber',
  我方动作: 'bg-primary',
  系统动作: 'bg-ink-2',
  期限: 'bg-amber',
};

/** 徽标底色。danger 一格都不给：色彩纪律里红色只留给风险与不可逆结论（DESIGN.md）。 */
const KIND_TONE: Record<string, BadgeTone> = {
  公司动作: 'amber',
  我方动作: 'primary',
  系统动作: 'neutral',
  期限: 'amber',
};

const VISIBLE_EVENTS = 4;

/**
 * 时间线一块（取数 + 登记 + 补选类型的状态都在这里）。
 * `demo` 为真时一次网络请求都不发，走演示数据（同 Dashboard 的分工）。
 */
export function CaseTimeline({ caseId, demo }: { caseId: string; demo: boolean }) {
  const [events, setEvents] = useState<TimelineEventView[] | null>(() =>
    demo ? demoEvents() : null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState<TimelineEventView | null>(null);

  useEffect(() => {
    if (demo) {
      setEvents(demoEvents());
      return;
    }
    let alive = true;
    setFailure(null);
    setEvents(null);
    fetchTimeline(caseId)
      .then((rows) => {
        if (alive) setEvents(rows);
      })
      .catch((err) => {
        // 取不到与"确实一条都没有"在屏幕上都是一片空白，但一个该说"再试一次"、
        // 另一个该说"从哪天记起"。把前者画成后者，等于告诉一个记过二十条的人：你什么都没记过。
        if (alive) setFailure(humanError(err));
      });
    return () => {
      alive = false;
    };
  }, [caseId, demo]);

  const onCreated = useCallback((created: TimelineEventView) => {
    setEvents((prev) => prependEvent(prev ?? [], created));
  }, []);

  const onTyped = useCallback((updated: TimelineEventView) => {
    setEvents((prev) => (prev === null ? prev : replaceEvent(prev, updated)));
  }, []);

  return (
    <>
      <TimelineSection
        caseId={caseId}
        events={events}
        failure={failure}
        /* 演示案件没有 cases 行，写进去会吃一条 404——那两个入口在演示态一律不出现 */
        canWrite={!demo}
        onAdd={() => setAdding(true)}
        onPickType={setPicking}
      />
      <AddEventSheet
        caseId={caseId}
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={onCreated}
      />
      <PickTypeSheet
        caseId={caseId}
        event={picking}
        onClose={() => setPicking(null)}
        onSaved={onTyped}
      />
    </>
  );
}

/**
 * 时间线的渲染面。**不取数、不写数**——判据据此可以直接喂一批真实事件进来看它渲染成什么，
 * 而不必在 node 环境里跑 effect（本仓没有 jsdom）。
 *
 * @param events null = 还在读（画骨架）；空数组 = 确实一条都没有（画空态）。
 *   两者合成一个的形态是：读的过程中屏幕上写着"你还没记过任何事"。
 */
export function TimelineSection({
  caseId,
  events,
  failure,
  canWrite,
  onAdd,
  onPickType,
}: {
  caseId: string;
  events: TimelineEventView[] | null;
  failure: string | null;
  canWrite: boolean;
  onAdd: () => void;
  onPickType: (event: TimelineEventView) => void;
}) {
  const pack = packOf(useCaseDomain(caseId));
  const [all, setAll] = useState(false);

  const ordered =
    events === null ? [] : [...events].sort((a, b) => b.happenedAt.localeCompare(a.happenedAt));
  const shown = all ? ordered : ordered.slice(0, VISIBLE_EVENTS);

  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">时间线</h3>
        {events !== null && <span className="num fs-xs text-ink-2">{events.length} 条</span>}
      </header>

      {canWrite && (
        <button
          type="button"
          onClick={onAdd}
          className="mb-3 inline-flex min-h-11 items-center rounded-[10px] border border-line px-3 fs-s font-medium text-primary-ink"
        >
          + {pack.copy.pages.timelineAddLabel}
        </button>
      )}

      {failure !== null ? (
        // 【只摆服务端那句话，不替它加一句宽心话】后端对「这个案件不存在」与
        // 「这个案件不是你的」回的是同一个码（lib/cases 的红线），所以这里补一句
        // "你记过的每一条都还在"就可能是在替一个用户根本没有的案件担保有材料
        // ——证据页那条 loadFailureAdvice 踩过同一处。三段式由服务端那句自己带。
        <Alert tone="danger">
          <AlertTitle>这一栏没读出来</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : events === null ? (
        <SkeletonList rows={3} />
      ) : ordered.length === 0 ? (
        <p data-veil="" className="fs-s text-ink-2">
          {pack.copy.pages.timelineEmpty}
        </p>
      ) : (
        <>
          <ol className="relative flex flex-col gap-4 pl-5">
            <span aria-hidden className="absolute top-2 bottom-2 left-[3.5px] w-px bg-line" />
            {shown.map((e) => (
              <TimelineRow
                key={e.id}
                event={e}
                typeLabel={labelOfType(pack.timelineEventTypes[e.kind], e.eventType)}
                /* 「选类型」只在**这一类有类型可选、而这一条没选过**时出现。
                   这一类不分型（空数组）时它整个不出现：那不是待填项，是结论。 */
                canPickType={
                  canWrite &&
                  e.eventType === null &&
                  (pack.timelineEventTypes[e.kind] ?? []).length > 0
                }
                onPickType={() => onPickType(e)}
              />
            ))}
          </ol>

          {ordered.length > VISIBLE_EVENTS && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="mt-2 min-h-11 fs-s text-primary-ink"
            >
              {all ? `只看最近 ${VISIBLE_EVENTS} 条` : `展开全部 ${ordered.length} 条`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * 落库的那个 id → 给人读的那一行字。
 * **认不出就不显示标签**（而不是把 id 原样印出来）：库里那个串是数据契约，
 * 印在屏幕上等于让用户去读一个他从来没被介绍过的词。
 */
function labelOfType(
  options: readonly { id: string; label: string }[] | undefined,
  eventType: string | null,
): string | null {
  if (eventType === null) return null;
  return options?.find((o) => o.id === eventType)?.label ?? null;
}

function TimelineRow({
  event,
  typeLabel,
  canPickType,
  onPickType,
}: {
  event: TimelineEventView;
  typeLabel: string | null;
  canPickType: boolean;
  onPickType: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    // data-cite：这一条是靠哪几份材料记下来的。停在它上面，下面证据行里
    // 对应那几条一起亮；反过来停在证据上，用过它的时间线条目也亮。
    <li
      data-veil=""
      data-cite={
        event.evidenceIds.length > 0
          ? event.evidenceIds.map(evidenceCiteId).join(' ')
          : undefined
      }
      className="relative"
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[7px] -left-5 size-2 rounded-full ring-4 ring-surface',
          KIND_DOT[event.kind] ?? 'bg-ink-2',
        )}
      />
      <p className="num fs-xs text-ink-2">{formatDate(event.happenedAt)}</p>
      <p className="fs-m font-medium text-ink">{event.title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={KIND_TONE[event.kind] ?? 'neutral'}>{event.kind}</Badge>
        {typeLabel !== null && <Badge tone="neutral">{typeLabel}</Badge>}
        {/* 来源档后缀由数据推出，不在这里猜（lib/cases/source-tier.tierMark）：
            〔未记录〕与〔自述〕是两句不同的话，合成一种就等于把"没有这条事实"
            读成"有，只是没人证"。 */}
        <span className="num fs-xs text-ink-2">{tierMark(event.sourceTier)}</span>
        {canPickType && (
          <button
            type="button"
            onClick={onPickType}
            className="inline-flex min-h-11 items-center fs-xs text-primary-ink"
          >
            选类型
          </button>
        )}
      </p>
      {event.detail !== '' && (
        <>
          <p className={cn('mt-0.5 fs-s text-ink-2', !open && 'line-clamp-2')}>
            <MaskedText text={event.detail} />
          </p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-11 items-center fs-xs text-primary-ink"
          >
            {open ? '收起' : '展开详情'}
          </button>
        </>
      )}
    </li>
  );
}
