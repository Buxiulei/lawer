/**
 * PC 侧栏里「接入自己的 agent」独立一栏的守卫。
 *
 * 【为什么值一组守卫】产品负责人 2026-09-03 明示这是核心能力，要「放在最左侧的栏目里，
 * 单独一栏」。这条要求的危险形态不是崩溃，是**悄悄退化**：
 *   · 有人按字母序或"新东西排最后"的直觉把它挪到四栏后面 —— 页面照样渲染、测试照样绿，
 *     而它就此变成一个没人看见的第六格；
 *   · 有人在 AppSidebar 里手写「接入我的 agent」几个字 —— 改口径的人改了 byoAgent.ts
 *     就以为改完了，侧栏还念着老词，两处说法从此分叉；
 *   · 有人图省事在这一栏自己判"有没有钥匙"，于是侧栏说已接入、驾驶舱说还没接。
 * 所以这里钉的是**顺序、文案来源、状态来源**三件事，不是"有没有这个链接"。
 *
 * 【量具边界】本仓 vitest 跑 node 环境、没有 DOM，所以用 renderToStaticMarkup 出静态
 * HTML 再按文本读顺序——验的是"这一屏的 DOM 里这几栏按什么次序排"。
 * 「1280 宽下它长在眼睛看得见的位置」由真机截图给证据，不由这里冒充。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO, BYO_GUIDE_HREF } from '@/app/_ui/byoAgent';
import { CASE_WORDS } from '@/app/_ui/neutral';

const ui = { discreet: false };
const agent = { loading: false, connected: false, name: '', nameIsKeyName: false, when: '' };

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));
// 接入状态只有这一个来源；这里替的是"那个来源今天回答什么"，不是另造一份判据。
vi.mock('@/app/_ui/useConnectedAgent', () => ({
  useConnectedAgent: () => agent,
}));
// props 要**整包透传**：SidebarMenuButton 走 asChild，isActive / tooltip 那些记号
// 是 Slot 合并到这个 <a> 上的。只挑 href 转发，高亮那条断言就永远读不到 data-active，
// 而它会红得像"高亮坏了"，其实是量具漏了一格。
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { AppSidebar, AgentNavBadge } = await import('../AppSidebar');
const { AGENT_NAV_ITEM, CASE_NAV_ITEMS, NAV_ITEMS } = await import('../navItems');
const { SidebarProvider } = await import('@/components/shadcn/sidebar');
const { TooltipProvider } = await import('@/components/shadcn/tooltip');
// 侧栏底部那个低调模式钮要 useToast（长按提示）。顶掉 Provider 而不是绕开整个侧栏：
// 这一组要的就是「整屏侧栏渲染出来之后，那一栏在第几位」。
const { ToastProvider } = await import('@/components/ui/Toast');
const { ThemeProvider } = await import('@/app/_ui/theme');

function html(pathname = '/case/c1'): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <ThemeProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar caseId="c1" caseTitle="张三 与 某公司" pathname={pathname} />
        </SidebarProvider>
      </TooltipProvider>
      </ThemeProvider>
    </ToastProvider>,
  );
}

/** 按 DOM 出现次序取出侧栏每一栏的可见文字（含徽标），用来验顺序。 */
function navTexts(markup: string): string[] {
  return [...markup.matchAll(/<a href="[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
}

beforeEach(() => {
  ui.discreet = false;
  Object.assign(agent, { loading: false, connected: false, name: '', when: '' });
});

describe('侧栏：接入那一栏的位置', () => {
  it('渲染出来了，且指向接入页', () => {
    expect(html()).toContain(`href="${BYO_GUIDE_HREF}"`);
  });

  it('排在驾驶舱之后、问它之前（核心功能前置，不是排在末尾）', () => {
    const texts = navTexts(html());
    const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
    const dash = at('驾驶舱');
    const mine = at(BYO.navLabel);
    const ask = at('问它');
    expect(dash, `没找到驾驶舱：${texts.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(mine, `没找到接入那一栏：${texts.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(ask, `没找到问它：${texts.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(mine).toBe(dash + 1);
    expect(ask).toBe(mine + 1);
  });

  it('NAV_ITEMS 的次序就是上面那个次序（数据层与渲染层不许分叉）', () => {
    const keys = NAV_ITEMS.map((i) => i.key);
    expect(keys.indexOf(AGENT_NAV_ITEM.key)).toBe(keys.indexOf('dashboard') + 1);
    expect(keys.indexOf('ask')).toBe(keys.indexOf(AGENT_NAV_ITEM.key) + 1);
  });

  it('底部 Tab 那四格一格没动——这一栏只进侧栏', () => {
    expect(CASE_NAV_ITEMS.map((i) => i.key)).toEqual([
      'dashboard',
      'ask',
      'evidence',
      'drafts',
    ]);
  });
});

describe('侧栏：接入那一栏的高亮', () => {
  it('站在接入页上它高亮', () => {
    expect(AGENT_NAV_ITEM.match(BYO_GUIDE_HREF, null)).toBe(true);
    // asChild 之下 data-active 落在 <a> 自己身上；属性次序不做假设，只认同一个标签内。
    const tag = (markup: string) =>
      markup.match(new RegExp(`<a[^>]*href="${BYO_GUIDE_HREF}"[^>]*>`))![0];
    expect(tag(html(BYO_GUIDE_HREF))).toContain('data-active="true"');
    // 反向对照：站在别处时同一个标签上没有这个记号（否则上一行恒真）
    expect(tag(html('/case/c1'))).not.toContain('data-active="true"');
  });

  it('站在别处不高亮', () => {
    expect(AGENT_NAV_ITEM.match('/case/c1', 'c1')).toBe(false);
    expect(AGENT_NAV_ITEM.match('/account', null)).toBe(false);
  });

  it('接入页上「我的」不跟着一起亮（/settings 整棵子树归它，这一页除外）', () => {
    const account = NAV_ITEMS.find((i) => i.key === 'account')!;
    expect(account.match('/settings', null)).toBe(true);
    expect(account.match('/settings/keys', null)).toBe(true);
    expect(account.match(BYO_GUIDE_HREF, null)).toBe(false);
  });
});

describe('侧栏：状态徽标两态', () => {
  it('没接上说「推荐」', () => {
    agent.connected = false;
    const markup = renderToStaticMarkup(<AgentNavBadge />);
    expect(markup).toContain(BYO.navBadgeIdle);
    expect(markup).toContain('data-agent-nav-badge="idle"');
  });

  it('接上了说「已接入」，不再推销', () => {
    agent.connected = true;
    const markup = renderToStaticMarkup(<AgentNavBadge />);
    expect(markup).toContain(BYO.navBadgeConnected);
    expect(markup).not.toContain(BYO.navBadgeIdle);
    expect(markup).toContain('data-agent-nav-badge="connected"');
  });

  it('首帧（还在取）两个字都不说——推销一次再翻牌，和撒谎，都不行', () => {
    agent.loading = true;
    const markup = renderToStaticMarkup(<AgentNavBadge />);
    expect(markup).not.toContain(BYO.navBadgeIdle);
    expect(markup).not.toContain(BYO.navBadgeConnected);
  });

  it('两态徽标都在整屏侧栏里真的渲染出来（不是只有组件单测绿）', () => {
    agent.connected = false;
    expect(html()).toContain(BYO.navBadgeIdle);
    agent.connected = true;
    expect(html()).toContain(BYO.navBadgeConnected);
  });
});

describe('低调模式', () => {
  it('栏目名换中性变体', () => {
    ui.discreet = true;
    const markup = html();
    expect(markup).toContain(BYO.navLabelNeutral);
    expect(markup).not.toContain(BYO.navLabel);
  });

  it('徽标不含案情词（两态都扫）', () => {
    ui.discreet = true;
    for (const connected of [false, true]) {
      agent.connected = connected;
      const text = renderToStaticMarkup(<AgentNavBadge />).replace(/<[^>]*>/g, '');
      for (const word of CASE_WORDS) expect(text, `${connected}/${word}`).not.toContain(word);
    }
  });
});

describe('文案唯一入口', () => {
  const SHELL = path.resolve(__dirname, '..');
  /**
   * 只抹注释，字符串与 JSX 文本照查（同 byo-agent-copy.test 里的 stripComments）。
   * 不抹的话，注释里解释「这一栏什么时候说已接入」的那句散文自己就把守卫弄红了，
   * 而下一个人会以为守卫坏了，顺手把它删掉。
   */
  const read = (f: string) =>
    fs
      .readFileSync(path.join(SHELL, f), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/([^:])\/\/[^\n]*/g, '$1');

  // 壳层三个文件谁手写了这几个字，改口径的人就会漏掉那一处，而它看起来完全正常。
  it.each(['AppShell.tsx', 'AppSidebar.tsx', 'navItems.tsx'])(
    '%s 里不许出现栏目名的字面量',
    (file) => {
      for (const literal of [BYO.navLabel, BYO.navLabelNeutral, BYO.navBadgeConnected]) {
        expect(read(file), `${file} 手写了「${literal}」，应当 import BYO`).not.toContain(literal);
      }
    },
  );

  it('反向对照：这几个字确实是从 byoAgent.ts 里来的', () => {
    expect(read('navItems.tsx')).toContain('BYO.navLabel');
    expect(read('AppSidebar.tsx')).toContain('BYO.navBadgeConnected');
  });
});
