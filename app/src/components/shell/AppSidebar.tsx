'use client';

import Link from 'next/link';
import { NEUTRAL_TITLE } from '@/app/_ui/bootstrap';
import { BYO } from '@/app/_ui/byoAgent';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useConnectedAgent } from '@/app/_ui/useConnectedAgent';
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
import { TubashuMark } from './TubashuMark';
import { AGENT_NAV_ITEM, NAV_ITEMS, caseHref } from './navItems';
import { useDiscreetToggle } from './useDiscreetToggle';

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
  caseId: string | null;
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
              <Link href={caseHref(caseId)}>
                <TubashuMark size={24} className="size-6" />
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
                    <span className="flex-1 truncate">{label}</span>
                    {item.key === AGENT_NAV_ITEM.key && <AgentNavBadge />}
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

/**
 * 接入那一栏右侧的状态小标：没接上说「推荐」，接上了说「已接入」。
 *
 * 【为什么不复制判据】接没接上只有 useConnectedAgent 一个来源（它自己的注释写着
 * 为什么）。这里再写一份"有钥匙就算接上"，形态是侧栏说已接入、驾驶舱说还没接，
 * 两边都看起来正常。
 *
 * 【loading 那一帧不占位】首帧恒为 loading（SSR 到不了 effect）。此时渲染「推荐」，
 * 已接入的用户每次刷新都会先被推销一次再翻牌；渲染「已接入」则是撒谎。所以不渲染。
 *
 * 【两种模式共用】「推荐 / 已接入」本来就不含案情词，低调模式下不需要中性变体——
 * 需要换词的是栏目名，那一份在 BYO.navLabelNeutral 里。
 */
export function AgentNavBadge() {
  const { loading, connected } = useConnectedAgent();
  if (loading) return null;
  return (
    <span
      data-agent-nav-badge={connected ? 'connected' : 'idle'}
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none',
        // 推荐那一态要被看见，用主色 wash；已接入是个安静的事实，不给底色。
        // 文字色一律走 -on-surface 那支：--primary-ink 压 surface 只有 3.86，
        // globals.css 里写着「主色文字不要再指它」。
        connected
          ? 'text-muted-foreground'
          : 'bg-primary-wash text-primary-ink-on-surface',
      )}
    >
      {connected ? BYO.navBadgeConnected : BYO.navBadgeIdle}
    </span>
  );
}

/**
 * 侧栏底部的低调模式开关。判定走 useDiscreetToggle，与顶栏眼睛钮、拇指区 PanicButton
 * 共用同一份：**单击开、按住 600ms 才关**。桌面鼠标按住同样算数——长按防的是误触，
 * 而误触在 PC 上照样发生（划过侧栏蹭一下就把金额亮出来）。
 *
 * 这里从前是 onClick={toggle} 双向直切：顶栏那条路堵上了，这条还开着，
 * 安全阀就等于没装。三个入口现在只准有这一份判定。
 * 导出是给 __tests__/sidebar-discreet-guard 直接调用，AppSidebar 内部照旧自己用。
 */
export function DiscreetMenuItem() {
  const { discreet, holding, pressProps } = useDiscreetToggle();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        {...pressProps}
        /* pressProps 里的 aria-label 是给顶栏那种纯图标钮写的，套到这个**有可见文字**的
           菜单项上会踩 WCAG 2.5.3（Label in Name）：可见文字是「低调模式」和「开 / 关」
           两个 span 直接相邻，无障碍名必须逐字包含它，否则语音控制的人念着屏幕上的字
           点不动它。所以这里覆盖掉，顺带把「按住才关」写进名字里——不然读屏用户只知道
           这是个开关，不知道单击关不掉。理由同 ThemeMenuItem 那条。 */
        aria-label={discreet ? '低调模式开，按住不放可关闭' : '低调模式关，单击开启'}
        tooltip={discreet ? '低调模式已开启（按住关闭）' : '低调模式'}
        isActive={discreet}
        className={cn(
          '[&>svg]:size-5 touch-none select-none',
          // 按住期间缩一下当进度反馈，与顶栏、拇指区同一形态。
          // 属性得一条条列全：tailwind-merge 把 transition-* 当同一组，只写
          // transition-transform 会把 SidebarMenuButton 基类那串顶掉，
          // 顺手就把 hover / 选中的配色过渡弄没了。
          'transition-[width,height,padding,background-color,color,transform] ease-out',
          holding ? 'scale-90 duration-[600ms]' : 'scale-100 duration-150',
        )}
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
            /* 无障碍名必须**逐字包含**可见文字（WCAG 2.5.3 Label in Name），
               而可见文字是两个 span 直接相邻＝「主题跟随系统」，中间没有空格。
               这里加任何分隔符都会断掉子串匹配，让语音控制的人念着屏幕上的字点不动它。
               中文本来就不分词，连写反而是自然读法。折叠成图标时仍靠它兜底。 */
            aria-label={`主题${THEME_LABEL[mode]}`}
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
