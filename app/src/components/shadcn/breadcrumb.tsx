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
        'flex flex-wrap items-center gap-1.5 text-[14px] text-muted-foreground',
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
      className={cn(
        // 面包屑是全站子页唯一的返回入口，文字本身只有 24px 高、最短的一条（「我的」）只有 28px 宽，
        // 达不到 DESIGN.md 的 ≥44×44。min-h-11 把命中区撑到 44，
        // 再用等量的负边距把多出来的部分从版式里减掉：
        // **横向** px-2 各扩 8px / -mx-2 减掉——顶栏被右侧四个 shrink-0 控件压到最窄时
        //   只剩约 40px，扩区不能占宽度；
        // **纵向** -my-2.5 减掉那 20px——`BreadcrumbList` 是 flex-wrap 的，
        //   顶栏挤到极限时会折成两行；若让这 44px 真的占版式，两行叠起来是 73.8px，
        //   要顶穿 56px 的顶栏 8.4px（实测；不减负边距时的对照值 53.6px 刚好塞得下）。
        'inline-flex min-h-11 items-center -mx-2 -my-2.5 px-2',
        'transition-colors duration-150 ease-out hover:text-foreground',
        className,
      )}
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
