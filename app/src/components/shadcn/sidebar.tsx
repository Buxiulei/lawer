'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { useHotkeys } from '@/app/_ui/hotkeys';
import { cn } from './utils';
import { Button } from './button';
import { PanelLeftIcon } from './icons';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/**
 * shadcn sidebar，按 Kiranism/next-shadcn-dashboard-starter 的骨架移植（MIT）。
 * 两处刻意的删减：
 *  1. 只做 PC（≥1024px）。移动端保留底部 Tab，不需要 Sheet 版侧栏，
 *     那一支连同 useIsMobile 一起去掉了。
 *  2. 只保留本项目用得上的槽位，没用上的（MenuSub / MenuBadge / MenuAction …）不搬。
 * 折叠状态存在 React state 里，靠 layout 常驻不随路由切换重置；不落 cookie，
 * 免得 (app) 路由组为了 SSR 读 cookie 整体变成动态渲染。
 */

const SIDEBAR_WIDTH = '15rem';
const SIDEBAR_WIDTH_ICON = '3.5rem';
const SIDEBAR_KEYBOARD_SHORTCUT = 'mod+b' as const;

interface SidebarContextValue {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar 必须在 SidebarProvider 内使用');
  return ctx;
}

function SidebarProvider({
  defaultOpen = true,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);

  const toggleSidebar = React.useCallback(() => setOpen((v) => !v), []);

  // ⌘B 原来在这里自己挂 window keydown。收编进 _ui/hotkeys 的唯一入口：
  // 它在桌面工作台上已经不只是「收起菜单」，而是「腾出第三栏」——
  // 跟 F6 / Esc 是同一套次序里的事，各挂各的就没人能回答「谁先吃这一下」。
  useHotkeys(
    React.useMemo(
      () => ({
        [SIDEBAR_KEYBOARD_SHORTCUT]: () => {
          toggleSidebar();
          return true;
        },
      }),
      [toggleSidebar],
    ),
  );

  const value = React.useMemo<SidebarContextValue>(
    () => ({ state: open ? 'expanded' : 'collapsed', open, setOpen, toggleSidebar }),
    [open, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': SIDEBAR_WIDTH,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn('group/sidebar-wrapper flex min-h-dvh w-full', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { state } = useSidebar();

  return (
    <div
      className="group peer hidden text-sidebar-foreground lg:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? 'icon' : ''}
      data-slot="sidebar"
    >
      {/* 占位块把内容区推开，固定定位的真身盖在它上面 */}
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden h-dvh w-(--sidebar-width) border-r border-sidebar-border',
          'transition-[width] duration-200 ease-linear lg:flex',
          'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
          className,
        )}
        {...props}
      >
        <div
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-sidebar"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, state } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      aria-label={state === 'expanded' ? '收起侧栏' : '展开侧栏'}
      className={cn('text-muted-foreground hover:bg-muted hover:text-foreground', className)}
      onClick={(e) => {
        onClick?.(e);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeftIcon />
    </Button>
  );
}

/** 侧栏右缘一条细边，点一下也能折叠——鼠标离得近，比顶栏按钮顺手 */
function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="折叠或展开侧栏"
      tabIndex={-1}
      onClick={toggleSidebar}
      className={cn(
        'absolute inset-y-0 -right-2 z-50 hidden w-4 cursor-w-resize lg:block',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border',
        'group-data-[state=collapsed]:cursor-e-resize',
        className,
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn('relative flex w-full min-w-0 flex-1 flex-col bg-background', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex flex-col gap-1 border-t border-sidebar-border p-2', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        'flex h-8 shrink-0 items-center px-2 text-[13px] font-medium text-sidebar-foreground/70',
        'transition-[margin,opacity] duration-200 ease-linear',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  cn(
    'flex w-full items-center gap-3 overflow-hidden rounded-[10px] p-2 text-left',
    'transition-[width,height,padding,background-color,color] duration-150 ease-out',
    'hover:bg-muted',
    'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
    // 折叠成图标条时只留图标：文字标签不能靠 overflow 裁，会漏出半个字
    'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:[&>span]:hidden',
    '[&>svg]:shrink-0 [&>span:last-child]:truncate',
  ),
  {
    variants: {
      size: {
        default: 'min-h-10 text-[15px] group-data-[collapsible=icon]:size-10!',
        lg: 'min-h-12 text-[15px] group-data-[collapsible=icon]:size-10!',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  size,
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof sidebarMenuButtonVariants> & {
    asChild?: boolean;
    isActive?: boolean;
    /** 折叠成图标条时用 tooltip 把文字补回来 */
    tooltip?: string;
  }) {
  const Comp = asChild ? Slot : 'button';
  const { state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ size }), className)}
      {...props}
    />
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed'}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
};
