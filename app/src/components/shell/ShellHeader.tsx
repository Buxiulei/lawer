'use client';

import Link from 'next/link';
import { cn } from '@/app/_ui/cn';
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
import { useDiscreetToggle } from './useDiscreetToggle';

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
  // 手机端顶栏只有这一个入口，没有单独的「接入」栏可亮，所以 /settings 整棵子树（含 /settings/agent）
  // 在手机上仍由「我的」承担位置指示；侧栏那边的互斥归 navItems.tsx 的 match 管，这里不复用它。
  const active = ACCOUNT_NAV_ITEM.match(pathname, '') || pathname.startsWith('/settings');
  return (
    <Link
      href={ACCOUNT_NAV_ITEM.href('')}
      aria-label={ACCOUNT_NAV_ITEM.label}
      aria-current={active ? 'page' : undefined}
      title={ACCOUNT_NAV_ITEM.label}
      className={cn(
        'flex size-11 items-center justify-center rounded-[10px] transition-colors duration-150 ease-out lg:hidden',
        active ? 'text-primary-ink-on-surface' : 'text-ink-2 hover:bg-surface-2',
      )}
    >
      {ACCOUNT_NAV_ITEM.icon}
    </Link>
  );
}

/**
 * 移动端才出现：PC 上同一个开关在侧栏底部。
 *
 * 判定与拇指区的 PanicButton 共用 useDiscreetToggle：单击开、按住 0.6 秒才关。
 * 顶栏这个从前是 onClick 双向直切，于是任意页面单击一下就能把打码撤掉——
 * 安全阀写在一处、绕过在另一处，所以两处现在只准有这一份判定。
 * 导出是给 __tests__/shell-discreet-guard 直接调用，AppShell 仍从 ShellHeader 进来。
 */
export function DiscreetButton() {
  const { discreet, holding, pressProps } = useDiscreetToggle();
  return (
    <button
      type="button"
      {...pressProps}
      title={discreet ? '低调模式已开启（按住关闭）' : '低调模式'}
      className={cn(
        'flex size-11 touch-none select-none items-center justify-center rounded-[10px] lg:hidden',
        // 按住期间缩一下当进度反馈，与 PanicButton 同一形态
        'transition-[color,background-color,transform] ease-out',
        holding ? 'scale-90 duration-[600ms]' : 'scale-100 duration-150',
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
