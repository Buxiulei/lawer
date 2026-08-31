'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { useCurrentCaseId } from '@/app/_ui/currentCase';
import { DocumentTitle, useDiscreet } from '@/app/_ui/discreet';
import { DiscreetVeil } from '@/app/_ui/veil';
import { SidebarInset, SidebarProvider } from '@/components/shadcn/sidebar';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import { AppSidebar } from './AppSidebar';
import { CasePanelProvider } from './casePanel';
import { DemoBanner } from './DemoBanner';
import { PanicButton } from './PanicButton';
import { RouteTransition } from './RouteTransition';
import { ShellHeader } from './ShellHeader';
import { CASE_NAV_ITEMS } from './navItems';

/**
 * 壳层：PC 是可折叠侧栏 + 顶栏，移动端是顶栏 + 底部 Tab。
 * 低调模式与主题的行为一律沿用 _ui/discreet 与 _ui/theme，这里只搬控件位置。
 */
export function AppShell({
  children,
  caseTitle,
}: {
  children: ReactNode;
  caseTitle: string;
}) {
  const pathname = usePathname() ?? '/';
  // 案件页取路径里的 id；非案件页取本人名下那个（取不到就是 null＝还不知道，绝不兜底成 demo）
  const caseId = useCurrentCaseId(pathname);
  const onDemoCase = /^\/case\/demo(\/|$)/.test(pathname);

  return (
    <TooltipProvider delayDuration={300}>
      <CasePanelProvider>
        <SidebarProvider>
          <DocumentTitle title={`${caseTitle} · 土八鼠`} />
          <DiscreetVeil />
          <AppSidebar caseId={caseId} caseTitle={caseTitle} pathname={pathname} />
          <SidebarInset>
            <ShellHeader pathname={pathname} caseId={caseId} />
            {onDemoCase && <DemoBanner />}
            {/* 正文默认限宽在可读区间。工作区**排开了侧栏**（data-panes）才解限宽——
                解了之后宽度归容器查询管（globals.css 批6-A）。
                原来的 data-wide 是「页面自称我要宽」，退役：它只有一个开关，
                答不了「宽到多少」「宽了给谁」，而这两问正是三栏要回答的。 */}
            {/* 有工作区时把左右留白让给它（`px-0`）：容器查询量的是容器**内容盒**，
                留白留在外面就等于每一档都少 48px——那正好是三栏差的那一口气。
                同样的 16/24 留白由 WorkspaceGrid 在容器**里面**补回来，观感不变。 */}
            <main className="mx-auto w-full max-w-[900px] flex-1 px-4 pt-3 pb-[calc(var(--tab-bar-h)+16px)] has-[[data-panes]]:max-w-none has-[[data-workspace]]:px-0 lg:px-6 lg:pb-10">
              <RouteTransition>{children}</RouteTransition>
            </main>
            <BottomTabs pathname={pathname} caseId={caseId} />
            <PanicButton />
          </SidebarInset>
        </SidebarProvider>
      </CasePanelProvider>
    </TooltipProvider>
  );
}

function BottomTabs({ pathname, caseId }: { pathname: string; caseId: string | null }) {
  const { discreet } = useDiscreet();
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto flex h-14 max-w-[860px]">
        {CASE_NAV_ITEMS.map((item) => {
          const active = item.match(pathname, caseId);
          // 低调下换中性词，图标和位置不动：肌肉记忆按的是那个位置，不是那两个字
          const label = (discreet && item.discreetLabel) || item.label;
          return (
            <li key={item.key} className="flex-1">
              <Link
                href={item.href(caseId)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-0.5',
                  active ? 'text-primary-ink-on-surface' : 'text-ink-2',
                )}
              >
                {item.icon}
                <span className="text-[11px] leading-none">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
