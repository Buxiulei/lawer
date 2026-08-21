'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { DocumentTitle } from '@/app/_ui/discreet';
import { SidebarInset, SidebarProvider } from '@/components/shadcn/sidebar';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import { AppSidebar } from './AppSidebar';
import { CasePanelProvider } from './casePanel';
import { ShellHeader } from './ShellHeader';
import { NAV_ITEMS } from './navItems';

const DEFAULT_CASE_ID = 'demo';

function caseIdFrom(pathname: string): string {
  const m = pathname.match(/^\/case\/([^/]+)/);
  return m ? m[1] : DEFAULT_CASE_ID;
}

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
  const caseId = caseIdFrom(pathname);

  return (
    <TooltipProvider delayDuration={300}>
      <CasePanelProvider>
        <SidebarProvider>
          <DocumentTitle title={`${caseTitle} · 裁员应对专员`} />
          <AppSidebar caseId={caseId} caseTitle={caseTitle} pathname={pathname} />
          <SidebarInset>
            <ShellHeader pathname={pathname} caseId={caseId} />
            {/* 正文默认限宽在可读区间；工作台那种双栏页面自己挂 data-wide 把上限抬上去 */}
            <main className="mx-auto w-full max-w-[900px] flex-1 px-4 pt-3 pb-[calc(56px+env(safe-area-inset-bottom)+16px)] has-[[data-wide]]:max-w-[1280px] lg:px-6 lg:pb-10">
              {children}
            </main>
            <BottomTabs pathname={pathname} caseId={caseId} />
          </SidebarInset>
        </SidebarProvider>
      </CasePanelProvider>
    </TooltipProvider>
  );
}

function BottomTabs({ pathname, caseId }: { pathname: string; caseId: string }) {
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto flex h-14 max-w-[860px]">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname, caseId);
          return (
            <li key={item.key} className="flex-1">
              <Link
                href={item.href(caseId)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-0.5',
                  active ? 'text-primary' : 'text-ink-2',
                )}
              >
                {item.icon}
                <span className="text-[11px] leading-none">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
