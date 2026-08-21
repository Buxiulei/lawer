'use client';

import { useState } from 'react';
import { cn } from '@/app/_ui/cn';
import type { ActionItem } from '@/app/_mock/types';
import { Checkbox } from '@/components/shadcn/checkbox';
import { DeadlineChip } from './DeadlineChip';

/**
 * 行动卡：checkbox + 标题 + 截止日 + 展开详情。
 * 勾选即完成，写回档案待办（接后端前由调用方持有状态）。
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
    <article
      className={cn(
        'rounded-[12px] border transition-colors duration-150 ease-out',
        done ? 'border-line bg-surface-2' : 'border-line bg-primary-wash',
      )}
    >
      <div className="flex items-start gap-3 p-3">
        {/* 外层撑满 44px 触区，勾选框本体仍是 20px */}
        <div className="flex min-h-11 min-w-11 items-center justify-center">
          <Checkbox
            checked={done}
            onCheckedChange={(next) => onToggle?.(item.id, next === true)}
            aria-label={`标记完成：${item.title}`}
          />
        </div>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="block w-full text-left"
          >
            <h3
              className={cn(
                'text-[16px] leading-7 font-semibold',
                done ? 'text-ink-2 line-through' : 'text-ink',
              )}
            >
              {item.title}
            </h3>
          </button>

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
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
      </div>
    </article>
  );
}
