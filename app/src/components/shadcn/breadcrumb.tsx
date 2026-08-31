import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from './utils';
import { ChevronRightIcon } from './icons';

/**
 * `min-w-0` 是这套收缩里**最外面那一环，少了它下游全部作废**：
 * 顶栏把 <nav> 当 flex item，flex item 的 min-width 默认解成 auto（= 内容宽），
 * 于是 nav 顶死在内容宽上，里面 BreadcrumbList 那套 shrink + truncate 一次都轮不到——
 * 类都在、效果一个没有。360×740 实测：修前 nav 右边缘越过「案件档案」按钮 12px。
 *
 * 收缩链一共三环，缺一不可：nav.min-w-0 → li:last-child.min-w-0+shrink → 子元素.truncate。
 * 判据在 scripts/perf/g5-breadcrumb.mjs（真浏览器量 clientWidth<scrollWidth），
 * 不是类串断言——类串证明不了这条链通没通，这个 bug 就是这么漏过去的。
 *
 * 修后 360 上不再压住按钮（净空 8px），但末项只剩 8px 可视宽——「问它」两个字全被省略号吃掉。
 * 那是右侧控件（案件档案 108 + 三个 44px 图标 = 252px）在 336px 的顶栏里占掉太多，
 * 不是收缩链的问题，归台账 **C-08b**，不在本组件范围内。
 */
function Breadcrumb({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      aria-label="面包屑"
      data-slot="breadcrumb"
      className={cn('min-w-0', className)}
      {...props}
    />
  );
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
