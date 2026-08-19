'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';
import { NEUTRAL_TITLE } from '@/app/_ui/bootstrap';
import { DocumentTitle, useDiscreet } from '@/app/_ui/discreet';
import { useTheme, type ThemeMode } from '@/app/_ui/theme';
import { LampMark } from './LampMark';
import { NAV_ITEMS } from './navItems';

const DEFAULT_CASE_ID = 'demo';

function caseIdFrom(pathname: string): string {
  const m = pathname.match(/^\/case\/([^/]+)/);
  return m ? m[1] : DEFAULT_CASE_ID;
}

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
    <div className="min-h-dvh lg:pl-[76px]">
      <DocumentTitle title={`${caseTitle} · 裁员应对专员`} />
      <TopBar caseTitle={caseTitle} />
      <SideRail pathname={pathname} caseId={caseId} />
      <main className="mx-auto w-full max-w-[860px] px-4 pt-3 pb-[calc(56px+env(safe-area-inset-bottom)+16px)] lg:px-6 lg:pb-10">
        {children}
      </main>
      <BottomTabs pathname={pathname} caseId={caseId} />
    </div>
  );
}

function TopBar({ caseTitle }: { caseTitle: string }) {
  const { discreet, toggle } = useDiscreet();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[860px] items-center gap-2 px-4 lg:px-6">
        <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">
          {discreet ? NEUTRAL_TITLE : caseTitle}
        </h1>

        <button
          type="button"
          onClick={toggle}
          aria-pressed={discreet}
          aria-label={discreet ? '关闭低调模式' : '开启低调模式'}
          title={discreet ? '低调模式已开启' : '低调模式'}
          className={cn(
            'flex size-11 items-center justify-center rounded-[10px] transition-colors duration-150 ease-out',
            discreet ? 'bg-primary-wash text-primary-ink' : 'text-ink-2 hover:bg-surface-2',
          )}
        >
          {discreet ? <EyeOffIcon /> : <EyeIcon />}
        </button>

        <ThemeButton />
      </div>
    </header>
  );
}

const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

function ThemeButton() {
  const { mode, cycle } = useTheme();
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`主题：${THEME_LABEL[mode]}，点击切换`}
      title={`主题：${THEME_LABEL[mode]}`}
      className="flex size-11 items-center justify-center rounded-[10px] text-ink-2 transition-colors duration-150 ease-out hover:bg-surface-2"
    >
      {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <AutoIcon />}
    </button>
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

function SideRail({ pathname, caseId }: { pathname: string; caseId: string }) {
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-y-0 left-0 z-40 hidden w-[76px] flex-col items-center gap-1 border-r border-line bg-surface pt-3 lg:flex"
    >
      <Link
        href={`/case/${caseId}`}
        aria-label="裁员应对专员 首页"
        className="mb-2 flex size-11 items-center justify-center"
      >
        <LampMark className="size-7 text-primary" />
      </Link>
      {NAV_ITEMS.map((item) => {
        const active = item.match(pathname, caseId);
        return (
          <Link
            key={item.key}
            href={item.href(caseId)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex w-[60px] flex-col items-center justify-center gap-1 rounded-[10px] py-2.5 transition-colors duration-150 ease-out',
              active ? 'bg-primary-wash text-primary' : 'text-ink-2 hover:bg-surface-2',
            )}
          >
            {item.icon}
            <span className="text-[12px] leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/* ── 图标：中性几何，不用法槌天平 ─────────────────────────── */

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l16 16" />
      <path d="M9.6 9.7A3 3 0 0014.3 14M6.3 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.5 4.3-1.1M19 15.4c1.6-1.6 2.5-3.4 2.5-3.4S18 5.5 12 5.5c-.7 0-1.4.1-2 .3" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M20 14.2A8.2 8.2 0 019.8 4 8.5 8.5 0 1020 14.2z" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none" />
    </svg>
  );
}
