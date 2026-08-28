'use client';

import { cn } from '@/app/_ui/cn';
import { formatDate } from '@/app/_ui/format';
import { deriveTrack, type Milestone, type TrackCell, type Attainment } from './milestones';

/**
 * 里程碑时间轴。**不是进度条**——产品方案第贰条明说线性进度对本产品失真：
 * 案子会走回头路（谈崩重回仲裁），进度条只会倒退，而里程碑轴能同时显示
 * 「前面进行中、后面已完成」，那才是回退的诚实样子。
 *
 * 四态**不靠颜色区分**：每格底下那行字才是判据（日期 / 进行中 / 未经此步 / 空），
 * 色盲、深色模式、截图压缩都不影响它。点的样式只是加速识别。
 *
 * 轨道**可变长**：进了法院就是八格。横向可滚，不折行——折行会让「先后」这个
 * 唯一的语义变得要靠读才知道。
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
    <section aria-label="案件进度" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
      <ol className="flex min-w-max gap-0 pt-1">
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
    // 4.35rem×5 = 348px，压得进 393 减去两侧 16px 内边距；八格轨道再横向滚
    <li className="relative flex min-w-[4.35rem] flex-col items-center px-0.5 pt-4">
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
      <span
        className={cn(
          'mt-1.5 text-[12px] leading-4 whitespace-nowrap',
          cell.state === '进行中' ? 'font-bold text-primary' : 'text-ink',
          cell.state === '未到' && 'text-ink-2',
        )}
      >
        {cell.milestone}
      </span>
      {/* 这一行是四态的真正判据，不是装饰 */}
      <span className="num mt-0.5 h-4 text-[11px] leading-4 whitespace-nowrap text-ink-2">
        {cell.state === '完成' && cell.at ? formatDate(cell.at) : ''}
        {cell.state === '进行中' ? '进行中' : ''}
        {cell.state === '跳过' ? '未经此步' : ''}
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
