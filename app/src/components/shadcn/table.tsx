import * as React from 'react';
import { cn } from './utils';

/**
 * 数据表格。布局手感抄 TailAdmin（表头一条 muted 底、行间只有一根细线、
 * 首末列 padding 撑开），色值一律走自家 token，不落第二套。
 *
 * 横向溢出由 Table 自带的外层容器兜住（overflow-x-auto），
 * 但窄屏真正的答案是**换成卡片列表**而不是让用户横向拖——
 * 见 data-table.tsx 的 sm 断点降级。
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-[15px]', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-border', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t border-border bg-muted/60 font-medium', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border transition-colors duration-150 ease-out',
        'data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'px-4 py-3 text-left align-middle text-[13px] leading-6 font-medium whitespace-nowrap text-muted-foreground',
        'first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-4 py-3.5 align-middle text-foreground', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-3 text-[13px] text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
};
