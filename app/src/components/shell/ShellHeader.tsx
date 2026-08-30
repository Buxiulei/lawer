'use client';

import Link from 'next/link';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useTheme } from '@/app/_ui/theme';
import { Separator } from '@/components/shadcn/separator';
import { SidebarTrigger } from '@/components/shadcn/sidebar';
import { Breadcrumbs } from './breadcrumbs';
import { useCasePanelOpener } from './casePanel';
import { THEME_LABEL } from './AppSidebar';
import { ACCOUNT_NAV_ITEM } from './navItems';
import {
  AutoIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  MoonIcon,
  SunIcon,
} from './shellIcons';

/**
 * 顶栏：左边折叠键 + 面包屑，右边案件档案入口。
 * 低调模式与主题在 PC 上已经下沉到侧栏底部，这里只在移动端（无侧栏）保留。
 * 「我的」同理：底部四格被案件四栏占满后它落在这里，PC 上仍在侧栏里。
 */
export function ShellHeader({
  pathname,
  caseId,
}: {
  pathname: string;
  caseId: string | null;
}) {
  const openCasePanel = useCasePanelOpener();

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur-sm lg:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="hidden lg:inline-flex" />
        <Separator orientation="vertical" className="hidden h-4 self-center lg:block" />
        <Breadcrumbs pathname={pathname} caseId={caseId} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {openCasePanel && (
          <button
            type="button"
            onClick={openCasePanel}
            className="flex h-11 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 text-[14px] text-ink transition-colors duration-150 ease-out hover:bg-surface-2 xl:hidden"
          >
            <FolderIcon />
            案件档案
          </button>
        )}
        <AccountButton pathname={pathname} />
        <DiscreetButton />
        <ThemeButton />
      </div>
    </header>
  );
}

/** 移动端才出现：PC 上同一条入口在侧栏导航里 */
function AccountButton({ pathname }: { pathname: string }) {
  const active = ACCOUNT_NAV_ITEM.match(pathname, '');
  return (
    <Link
      href={ACCOUNT_NAV_ITEM.href('')}
      aria-label={ACCOUNT_NAV_ITEM.label}
      aria-current={active ? 'page' : undefined}
      title={ACCOUNT_NAV_ITEM.label}
      className={cn(
        'flex size-11 items-center justify-center rounded-[10px] transition-colors duration-150 ease-out lg:hidden',
        active ? 'text-primary' : 'text-ink-2 hover:bg-surface-2',
      )}
    >
      {ACCOUNT_NAV_ITEM.icon}
    </Link>
  );
}

/** 移动端才出现：PC 上同一个开关在侧栏底部 */
function DiscreetButton() {
  const { discreet, toggle } = useDiscreet();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={discreet}
      aria-label={discreet ? '关闭低调模式' : '开启低调模式'}
      title={discreet ? '低调模式已开启' : '低调模式'}
      className={cn(
        'flex size-11 items-center justify-center rounded-[10px] transition-colors duration-150 ease-out lg:hidden',
        discreet ? 'bg-primary-wash text-primary-ink' : 'text-ink-2 hover:bg-surface-2',
      )}
    >
      {discreet ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

function ThemeButton() {
  const { mode, cycle } = useTheme();
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`主题：${THEME_LABEL[mode]}，点击切换`}
      title={`主题：${THEME_LABEL[mode]}`}
      className="flex size-11 items-center justify-center rounded-[10px] text-ink-2 transition-colors duration-150 ease-out hover:bg-surface-2 lg:hidden"
    >
      {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <AutoIcon />}
    </button>
  );
}
