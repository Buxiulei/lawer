'use client';

import Link from 'next/link';
import { NEUTRAL_TITLE } from '@/app/_ui/bootstrap';
import { useDiscreet } from '@/app/_ui/discreet';
import { useTheme, type ThemeMode } from '@/app/_ui/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/shadcn/sidebar';
import { AutoIcon, EyeIcon, EyeOffIcon, MoonIcon, SunIcon } from './shellIcons';
import { LampMark } from './LampMark';
import { NAV_ITEMS } from './navItems';

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/** NAV_ITEMS 的图标为底部 Tab 写死了 size-6，侧栏这边压到 20px */
const NAV_ICON = '[&>svg]:size-5';

/**
 * PC 侧栏：案件名 + 主导航，低调模式与主题下沉到底部 user 区。
 * 移动端不渲染（Sidebar 自带 lg 断点），那边走底部 Tab。
 */
export function AppSidebar({
  caseId,
  caseTitle,
  pathname,
}: {
  caseId: string;
  caseTitle: string;
  pathname: string;
}) {
  const { discreet } = useDiscreet();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip={discreet ? NEUTRAL_TITLE : caseTitle}
              className="gap-2.5"
            >
              <Link href={`/case/${caseId}`}>
                <LampMark className="size-6 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-sidebar-foreground">
                  {discreet ? NEUTRAL_TITLE : caseTitle}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>案件</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
              const label = (discreet && item.discreetLabel) || item.label;
              return (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  asChild
                  tooltip={label}
                  isActive={item.match(pathname, caseId)}
                  className={NAV_ICON}
                >
                  <Link href={item.href(caseId)}>
                    {item.icon}
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <DiscreetMenuItem />
          <ThemeMenuItem />
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function DiscreetMenuItem() {
  const { discreet, toggle } = useDiscreet();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={toggle}
        aria-pressed={discreet}
        tooltip={discreet ? '低调模式已开启' : '低调模式'}
        isActive={discreet}
        className="[&>svg]:size-5"
      >
        {discreet ? <EyeOffIcon /> : <EyeIcon />}
        <span className="flex-1 truncate text-left">低调模式</span>
        <span className="text-[13px] text-muted-foreground">{discreet ? '开' : '关'}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ThemeMenuItem() {
  const { mode, setMode } = useTheme();
  const Icon = mode === 'light' ? SunIcon : mode === 'dark' ? MoonIcon : AutoIcon;

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            aria-label={`主题 ${THEME_LABEL[mode]}`}
            tooltip={`主题：${THEME_LABEL[mode]}`}
            className="[&>svg]:size-5"
          >
            <Icon />
            <span className="flex-1 truncate text-left">主题</span>
            <span className="text-[13px] text-muted-foreground">{THEME_LABEL[mode]}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-40">
          {(Object.keys(THEME_LABEL) as ThemeMode[]).map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => setMode(option)}
              aria-current={option === mode ? 'true' : undefined}
              className={option === mode ? 'font-semibold text-primary-ink' : undefined}
            >
              {THEME_LABEL[option]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
