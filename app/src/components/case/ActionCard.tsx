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

  return (
    <article data-veil="" className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        {/* **标题与勾选框同属一个 label**：热区从 28px 的标题本身扩到整行，
          高度不变（批 3）。批 1 报过标题按钮只有 28px 高，
          当时的算法是"把按钮做高"，每行要多 16px、与密度目标冲突；
          改成扩热区就没有这个代价。
          **代价是标题点击的语义变了**：以前点标题是展开，现在是勾选完成——
          展开仍有正下方那个「为什么要做这件事」，而"点标题=勾掉这件事"
          和旁边的勾选框是同一个动作，比"点标题展开、点框勾选"更好猜。 */}
        <label className="flex min-h-11 flex-1 cursor-pointer items-start gap-3">
        <span className="flex min-h-11 min-w-11 items-center justify-center">
          <Checkbox
            checked={done}
            onCheckedChange={(next) => onToggle?.(item.id, next === true)}
            aria-label={`标记完成：${item.title}`}
          />
        </span>
        <span className="flex min-h-11 min-w-0 flex-1 items-center">
          <h4
            className={cn(
              'text-[16px] leading-7 font-semibold',
              done ? 'text-ink-2 line-through' : 'text-ink',
            )}
          >
            {item.title}
          </h4>
        </span>
        </label>
      </div>

      <div className="ml-14">
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
}: {
  items: ActionItem[];
  onToggle?: (id: string, done: boolean) => void;
  /** 首诊预览用「现在做这三件事」，工作台用默认值 */
  title?: string;
}) {
  if (items.length === 0) return null;
  const done = items.filter((a) => a.status === '完成').length;

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
        {items.map((item) => (
          <ActionCard key={item.id} item={item} onToggle={onToggle} />
        ))}
      </div>
    </section>
  );
}
