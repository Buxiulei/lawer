import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from './utils';
import { ChevronRightIcon } from './icons';

function Breadcrumb(props: React.ComponentProps<'nav'>) {
  return <nav aria-label="面包屑" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        // 移动端不许换行：顶栏 h-14 固定 56px，面包屑一换到第二行，离下边界只剩 1.7px，
        // 看着像顶穿（360×740 复现，393 正常）。宁可末项出省略号，也不换行。
        // sm 往上放回 flex-wrap：那边宽度够，本来也换不了行。
        'flex flex-nowrap items-center gap-1.5 text-[14px] text-muted-foreground sm:flex-wrap',
        // 挤压全部落在末项。前几级 shrink-0：它们是"回哪儿去"的路，被压窄就点不准；
        // whitespace-nowrap 也不能少——中文没有单词边界，不写它「驾驶舱」会被逐字折成三行。
        // 末项反过来要能缩到 0：truncate 自带 overflow:hidden，min-width:auto 才会解成 0。
        '[&>li]:shrink-0 [&>li]:whitespace-nowrap',
        '[&>li:last-child]:min-w-0 [&>li:last-child]:shrink [&>li:last-child>*]:truncate',
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn('inline-flex items-center gap-1.5', className)}
      {...props}
    />
  );
}

function BreadcrumbLink({
  className,
  asChild,
  ...props
}: React.ComponentProps<'a'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn('transition-colors duration-150 ease-out hover:text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('font-medium text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ className, children, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden
      className={cn('text-muted-foreground/70 [&>svg]:size-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRightIcon />}
    </li>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
