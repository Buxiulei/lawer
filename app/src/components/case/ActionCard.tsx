'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/app/_ui/cn';
import type { ActionItem } from '@/app/_mock/types';
import { HAPTIC, haptic } from '@/app/_ui/motion';
import { Checkbox } from '@/components/shadcn/checkbox';
import { useDoneCollapse } from '@/hooks/useDoneCollapse';
import { DeadlineChip } from './DeadlineChip';

/**
 * 行动卡的**一行**（借 GOV.UK Task List 的行结构）。
 *
 * 批 1 起它不再是一张独立的卡：整组待办由 ActionGroup 包成**一张**带实边框和填色顶栏的卡，
 * 这里只负责行内容 + 行间分隔线。**理由**：五种语义此前共用同一个 12px 圆角描边盒、
 * 只靠底色区分，而那几个底色彼此对比度只有 1.02–1.15:1——
 * 手机上一屏摞四五张，"现在该做什么"根本跳不出来。
 * 分量差别改由**结构**承载（实边框 + 填色顶栏），不靠底色。
 */
export function ActionCard({
  item,
  onToggle,
  onCollapsed,
  defaultExpanded = false,
}: {
  item: ActionItem;
  onToggle?: (id: string, done: boolean) => void;
  /** 给了就开「勾完自己收起」（见 `useDoneCollapse`）；不给就是今天的样子 */
  onCollapsed?: (id: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const done = item.status === '完成';
  const checkboxId = `action-${item.id}`;
  const collapsible = onCollapsed !== undefined;
  const { wrap, undoable, undo } = useDoneCollapse(collapsible && done, () =>
    onCollapsed?.(item.id),
  );

  return (
    /* overflow-hidden 是收起动画的必需品：高度收到 0 的过程中内容要被裁掉，
       否则文字会溢出压到下一行上。不收起时它对版式无影响。 */
    <div ref={wrap} className="overflow-hidden">
      <article data-veil="" className="flex items-start gap-3 px-3 py-2.5">
        {/* 外层撑满 44px 触区，勾选框本体仍是 20px */}
        <div className="flex min-h-11 min-w-11 items-center justify-center">
          <Checkbox
            id={checkboxId}
            checked={done}
            onCheckedChange={(next) => {
              // 微操作确认。触觉是可选增强，**没有任何信息只由它承载**
              if (next === true) haptic(HAPTIC.actionDone);
              onToggle?.(item.id, next === true);
            }}
            aria-label={`标记完成：${item.title}`}
            className="mo-check"
          />
        </div>

        <div className="min-w-0 flex-1">
          {/* **热区做大，不是把行做高。**（批 1 报的 28px 遗留）
              批 1 当时的算法是把按钮撑到 44，那样每行要多 16px、与密度目标冲突。
              这里用 `py-2` 把可点高度撑到 44，再用等量的 `-my-2` 把它从版式里减掉——
              **占位仍是 28px，命中区是 44px。**
              标题绑到勾选框：点标题＝勾掉这件事，和旁边那个框同一个动作；
              展开另有正下方的「为什么要做这件事」。

              **只用 htmlFor，不要再加 onClick**：button 是 labelable 元素，
              浏览器会把 label 的点击转发给它。再挂一个 onClick 就会**点一次翻两次**——
              自己翻一次、转发再翻回来，净效果是纹丝不动。
              （我确实先加了 onClick 才发现这点：当时的"点了没反应"其实是测试点在了
              视口外面，元素根本没被碰到。） */}
          <label
            htmlFor={checkboxId}
            className="-my-2 flex min-h-11 cursor-pointer items-center py-2"
          >
            {/* 划线用 `text-decoration-color`，**不用绝对定位的划线条**：
                标题会折行，绝对定位只画得出一行。
                静止判据没丢——`line-through` 常驻，减弱动效下颜色瞬间到位，线照样在。 */}
            <h4
              data-done={done ? '1' : undefined}
              className={cn(
                'mo-strike text-[16px] leading-7 font-semibold',
                done ? 'text-ink-2' : 'text-ink',
              )}
            >
              {item.title}
            </h4>
          </label>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {item.dueAt && <DeadlineChip dueAt={item.dueAt} showDate />}
            {undoable ? (
              /* 收起过程中 UI 保持可点：点了立刻反向，不等动画放完 */
              <button
                type="button"
                onClick={() => {
                  undo();
                  onToggle?.(item.id, false);
                }}
                className="min-h-11 text-[14px] font-semibold text-primary-ink underline underline-offset-4"
              >
                撤销
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="min-h-11 text-[14px] text-primary-ink"
              >
                {expanded ? '收起' : '为什么要做这件事'}
              </button>
            )}
          </div>

          {expanded && (
            <p className="prose-measure mt-1 pb-1 text-[15px] leading-7 text-ink-2">
              {item.detail}
            </p>
          )}
        </div>
      </article>
    </div>
  );
}

/**
 * 「现在做什么」整组：**分量 5**，全页第二重（仅次于危机轮热线块）。
 *
 * 结构借 GOV.UK Notification Banner 的外框 + Task List 的行：
 * **4px 实边框包整卡 + 填色顶栏**。验收第 3 条要求它是首屏内唯一同时具备
 * 「填色顶栏 + 实边框」的元素——期限提示只有顶栏没有外框，正是为了让这两者不打架。
 */
export function ActionGroup({
  items,
  onToggle,
  title = '现在做什么',
  limit,
  collapseOnDone = false,
}: {
  items: ActionItem[];
  onToggle?: (id: string, done: boolean) => void;
  /** 首诊预览用「现在做这三件事」，工作台用默认值 */
  title?: string;
  /**
   * 只渲染前几行。驾驶舱传 1——产品方案要「任何时刻首页只推一件事」。
   * **计数照旧按 `items` 全量算**：只传一条进来会显示 0/1，那是谎报。
   */
  limit?: number;
  /**
   * 勾完的行停 700ms 后自己收起，把位置让给下一件事（《动效语言》§2 B）。
   *
   * **默认关**，只有驾驶舱开。对话流里这一组是那一轮回复的**记录**，
   * 首诊预览里是「这三件事」的**清单**——两处的行消失都是丢信息，不是让路。
   */
  collapseOnDone?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const done = items.filter((a) => a.status === '完成').length;
  const sweepKey = useCountSweep(done);
  const cleared = items.length > 0 && done === items.length;

  if (items.length === 0) return null;
  const live = collapseOnDone ? items.filter((a) => !collapsed.includes(a.id)) : items;
  const shown = limit === undefined ? live : live.slice(0, limit);

  return (
    <section
      data-action-group
      className={cn(
        'prose-measure mo-fade-in mo-track-tint mt-4 rounded-[12px] border-4 bg-surface',
        cleared ? 'border-success' : 'border-primary',
      )}
    >
      {/* 整组清空配得上一次奖励，而且不撒谎：换的是底色与标题，**不撒彩带**。
          `cheer` 姿势按 `Mascot` 的规矩只给真里程碑，勾完一批待办是小操作。 */}
      <h3
        data-sweep={sweepKey || undefined}
        key={sweepKey}
        className={cn(
          'mo-sweep mo-track-tint flex items-baseline justify-between gap-2 px-3 py-2 text-on-primary',
          cleared ? 'bg-success' : 'bg-primary',
        )}
      >
        <span className="text-[15px] font-semibold">{cleared ? '这一批做完了' : title}</span>
        <span className="num text-[13px] opacity-90">
          {done}/{items.length}
        </span>
      </h3>
      {/* divide-y 而不是每行自己画底线：行数不定，分隔线是容器的事 */}
      <div className="flex flex-col divide-y divide-line">
        {shown.map((item) => (
          <ActionCard
            key={item.id}
            item={item}
            onToggle={onToggle}
            onCollapsed={
              collapseOnDone
                ? (id) => setCollapsed((prev) => (prev.includes(id) ? prev : [...prev, id]))
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 计数**增加**时给顶栏一个新 key，让那道横扫高光重播一次。
 *
 * 只认增加：减少（撤销）不是成就，不该奖励。
 * 数字本身直接换，不做翻牌轮——翻牌轮把「3」这个要读的东西变成一段要等的动画。
 */
function useCountSweep(done: number): number {
  const prev = useRef(done);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (done > prev.current) setKey((k) => k + 1);
    prev.current = done;
  }, [done]);
  return key;
}
