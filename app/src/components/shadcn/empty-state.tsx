import * as React from 'react';
import { cn } from './utils';

/**
 * 空状态。文案给确定感，不写「暂无数据」这类无信息量的句子。
 *
 * **description 必须带 `data-veil`**：它是正文，低调模式二档要把它糊掉。
 * 这个属性在 B2(#53) 从手写版迁过来时掉了，于是文书/证据/图谱三页的空状态
 * 成了满屏模糊里唯一一段清晰文字——**比全不糊更扎眼，眼睛会直接被它吸过去**。
 * 打码判定看的是字段类型（这是正文）不是内容真假，所以没有"这句话不敏感"的例外。
 * 见同目录 __tests__/empty-state.test.tsx。
 */
function EmptyState({
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center rounded-[12px] border border-dashed border-border bg-card px-6 py-14 text-center',
        className,
      )}
      {...props}
    >
      <p className="text-[16px] font-semibold text-foreground">{title}</p>
      {description && (
        <p
          data-veil=""
          className="prose-measure mt-2 text-[15px] leading-7 text-muted-foreground"
        >
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export { EmptyState };
