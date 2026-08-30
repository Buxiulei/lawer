'use client';

import { useState } from 'react';
import { cn } from '@/app/_ui/cn';
import type { ActionItem } from '@/app/_mock/types';
import { Checkbox } from '@/components/shadcn/checkbox';
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
  defaultExpanded = false,
}: {
  item: ActionItem;
  onToggle?: (id: string, done: boolean) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const done = item.status === '完成';
  const checkboxId = `action-${item.id}`;

  return (
    <article data-veil="" className="flex items-start gap-3 px-3 py-2.5">
      {/* 这层只做一件事：让 20px 的框在 44px 高的标题行里居中对齐。
          **触区不在这层**——它在 Checkbox 自己身上（伪元素扩区，见 shadcn/checkbox.tsx）。
          这里原先的注释把触区算在这层头上，而纯 CSS 居中不转发点击，
          实测可点范围一直是 20×20（审查台账 SYS-03）。 */}
      <div className="flex min-h-11 min-w-11 items-center justify-center">
        <Checkbox
          id={checkboxId}
          checked={done}
          onCheckedChange={(next) => onToggle?.(item.id, next === true)}
          aria-label={`标记完成：${item.title}`}
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
          <h4
            className={cn(
              'text-[16px] leading-7 font-semibold',
              done ? 'text-ink-2 line-through' : 'text-ink',
            )}
          >
            {item.title}
          </h4>
        </label>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          {item.dueAt && <DeadlineChip dueAt={item.dueAt} showDate />}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="min-h-11 text-[14px] text-primary-ink"
          >
            {expanded ? '收起' : '为什么要做这件事'}
          </button>
        </div>

        {expanded && (
          <p className="prose-measure mt-1 pb-1 text-[15px] leading-7 text-ink-2">
            {item.detail}
          </p>
        )}
      </div>
    </article>
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
}) {
  if (items.length === 0) return null;
  const done = items.filter((a) => a.status === '完成').length;
  const shown = limit === undefined ? items : items.slice(0, limit);

  return (
    <section
      data-action-group
      className="prose-measure mt-4 animate-[fade-in_200ms_ease-out] rounded-[12px] border-4 border-primary bg-surface"
    >
      <h3 className="flex items-baseline justify-between gap-2 bg-primary px-3 py-2 text-on-primary">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="num text-[13px] opacity-90">
          {done}/{items.length}
        </span>
      </h3>
      {/* divide-y 而不是每行自己画底线：行数不定，分隔线是容器的事 */}
      <div className="flex flex-col divide-y divide-line">
        {shown.map((item) => (
          <ActionCard key={item.id} item={item} onToggle={onToggle} />
        ))}
      </div>
    </section>
  );
}
