'use client';

import { cn } from '@/app/_ui/cn';
import { formatDate, formatMonthDay } from '@/app/_ui/format';
import { deriveTrack, type Milestone, type TrackCell, type Attainment } from './milestones';

/**
 * 里程碑时间轴。**不是进度条**——产品方案第贰条明说线性进度对本产品失真：
 * 案子会走回头路（谈崩重回仲裁），进度条只会倒退，而里程碑轴能同时显示
 * 「前面进行中、后面已完成」，那才是回退的诚实样子。
 *
 * 四态**不靠颜色区分**：每格底下那行字才是判据（日期 / 进行中 / 未经此步 / 空），
 * 色盲、深色模式、截图压缩都不影响它。点的样式只是加速识别。
 *
 * **八段常显、压缩节距，不横滚**（2026-08-29 用户令 + manager 裁定）：
 * 一审/二审/执行没走到也摆在那，因为用户要的是「全程陪跑」的视觉承诺。
 * **滚动能到达 ≠ 一眼看见**——把后三段推到屏外，等于承诺没露出来。
 * 代价：393 下每格约 45px，日期缩成 `07/24`（≥sm 恢复完整），「仲裁申请」折两行。
 * 完整日期挂在 `title` 上不丢。
 */
export function MilestoneTrack({
  track,
  attainments,
}: {
  track: readonly Milestone[];
  attainments: readonly Attainment[];
}) {
  const cells = deriveTrack(track, attainments);
  return (
    <section aria-label="案件进度" className="pt-1">
      {/* 不用 min-w-max：八格要在 393 里排满，靠 flex-1 均分而不是靠溢出滚动 */}
      <ol className="flex gap-0">
        {cells.map((cell, i) => (
          <Cell key={cell.milestone} cell={cell} first={i === 0} prev={cells[i - 1]} />
        ))}
      </ol>
    </section>
  );
}

/** 连接线的颜色跟**前一格**走：走过的路是实的，没走的是虚的 */
function Cell({ cell, first, prev }: { cell: TrackCell; first: boolean; prev?: TrackCell }) {
  // 「进行中」那一格是**站在上面**，不是走过去了——它后面那截线还得是灰的，
  // 否则轨道会显得比实际进度多走一格
  const walked = prev?.state === '完成' || prev?.state === '跳过';
  return (
    // flex-1 均分：393 下八格每格约 45px。min-w-0 是必须的——
    // 没有它，子元素的最小内容宽度（「仲裁申请」四个字）会把 flex-1 顶开、整行溢出
    <li className="relative flex min-w-0 flex-1 flex-col items-center px-0.5 pt-4">
      {!first && (
        <span
          aria-hidden
          /* top 必须落在圆点竖直中心：li 有 pt-4(16px)，点高 12px ⇒ 中心 22px，线高 2px ⇒ 21px。
             照原型稿抄 top:5px 会把线画到点的上方 16px 处——那份稿子的点是 top:0 定位的。 */
          className={cn(
            'absolute top-[21px] right-1/2 left-[-50%] h-0.5',
            walked ? 'bg-success' : 'bg-line',
          )}
        />
      )}
      <Dot state={cell.state} />
      {/*
        **点不打糊、字打糊**。低调模式下这几个词是全页最要命的：
        「仲裁申请 / 立案 / 开庭 / 裁决」连起来，不知情的人一眼就知道这台手机在办什么事——
        比金额还准。圆点本身不含信息，留着清晰是为了轨道还看得出形状，不至于糊成一团。
      */}
      <span
        data-veil=""
        className={cn(
          /* 允许折行：45px 装不下「仲裁申请」四个字。
             **不能加 `break-keep`**——它阻止中文词内换行，于是那格不折行而是**溢出格子**
             压到邻格上；实测 360/393 下正是这一格 scrollWidth > clientWidth。
             高度固定两行：只有一格会折，不锁高的话它下面那行日期会比别人低一截，
             而那行是四态判据，错位会让整条轨道读起来像坏了。 */
          'mt-1.5 flex h-[2.5em] items-start justify-center px-px text-center',
          'text-[11.5px] leading-[1.25] sm:text-[12px]',
          cell.state === '进行中' ? 'font-bold text-primary' : 'text-ink',
          cell.state === '未到' && 'text-ink-2',
        )}
      >
        {cell.milestone}
      </span>
      {/* 这一行是四态的真正判据，不是装饰——四种状态各有一句不同的字，不靠颜色分 */}
      <span
        data-veil=""
        title={cell.state === '完成' && cell.at ? formatDate(cell.at) : undefined}
        className="num mt-0.5 h-4 text-[10.5px] leading-4 whitespace-nowrap text-ink-2 sm:text-[11px]"
      >
        {cell.state === '完成' && cell.at && (
          <>
            <span className="sm:hidden">{formatMonthDay(cell.at)}</span>
            <span className="hidden sm:inline">{formatDate(cell.at)}</span>
          </>
        )}
        {cell.state === '进行中' ? '进行中' : ''}
        {cell.state === '跳过' ? (
          <>
            <span className="sm:hidden">未经</span>
            <span className="hidden sm:inline">未经此步</span>
          </>
        ) : (
          ''
        )}
      </span>
    </li>
  );
}

function Dot({ state }: { state: TrackCell['state'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative z-[1] block size-3 rounded-full border-2',
        state === '完成' && 'border-success bg-success',
        state === '进行中' && 'border-primary bg-primary ring-3 ring-primary-wash',
        state === '跳过' && 'border-line bg-line',
        state === '未到' && 'border-line bg-bg',
      )}
    />
  );
}
