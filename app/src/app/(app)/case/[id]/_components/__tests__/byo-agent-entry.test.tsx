/**
 * 驾驶舱的常驻入口 + 对话页的已接入提示条。
 *
 * 【为什么提示条要单独一组】它是**条件渲染**的：没接入的人不该看见。
 * 这类组件最常见的坏法有两种，两种都不报错：
 *   ① 条件写反 / 忘了写 —— 每个人都看见一条与自己无关的话；
 *   ② 条件太严 —— 谁都看不见，而"看不见"和"这功能没做"在页面上长得一模一样。
 * 所以两侧都钉：没接入必须渲染成空串（不是空 div），接入了必须出现且**不阻断**。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO, BYO_GUIDE_HREF, byoBillingLine } from '@/app/_ui/byoAgent';
import type { ConnectedAgent } from '@/app/_ui/useConnectedAgent';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, toggle: () => {} }),
  DocumentTitle: () => null,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** 接入态的替身。真 hook 要发请求，SSR 到不了 effect——这里直接给结论。 */
const conn: ConnectedAgent = {
  loading: false,
  connected: false,
  name: '',
  nameIsKeyName: false,
  when: '',
};
vi.mock('@/app/_ui/useConnectedAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/useConnectedAgent')>()),
  useConnectedAgent: () => conn,
}));

const { DashboardBody } = await import('../Dashboard');
const { demoDashboard } = await import('../dashboardData');
const { ByoAgentNotice } = await import('../ByoAgentNotice');

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  ui.discreet = false;
  Object.assign(conn, { loading: false, connected: false, name: '', nameIsKeyName: false, when: '' });
});

/* ── J9 驾驶舱常驻入口 ─────────────────────────────────── */

describe('J9 驾驶舱：「用你自己的 agent」有一条常驻入口', () => {
  const dash = () => ssr(<DashboardBody caseId="1" data={demoDashboard('1')} />);

  it('入口在，且指向一页式指南', () => {
    const html = dash();
    expect(html).toContain(`href="${BYO_GUIDE_HREF}"`);
    expect(text(html)).toContain(BYO.title);
  });

  it('带着完整计费口径，不是只挂一个标题', () => {
    // 变异核：把 byoBillingLine 那一行删成只剩标题，这条立刻红
    expect(text(dash())).toContain(
      byoBillingLine({ credit: '公道值', watch: '守望', discreet: false }),
    );
  });

  it('低调模式：标题换中性词，整段不带案情词也不带「公道值」', () => {
    ui.discreet = true;
    const html = dash();
    const t = text(html);
    expect(t).toContain(BYO.titleNeutral);
    expect(t).not.toContain(BYO.title);
    expect(t).toContain(byoBillingLine({ credit: '额度', watch: '关注', discreet: true }));
    // 换词换不干净就是一次泄漏：整屏一个「公道值」都不许剩
    expect(t).not.toContain('公道值');
    expect(html).toContain('data-veil'); // 正文照旧进糊层
  });

  it('已接入之后收成一行状态，不再重复推销', () => {
    Object.assign(conn, {
      connected: true,
      name: 'claude-code',
      when: '2026/09/02 10:00',
    });
    const t = text(dash());
    expect(t).toContain('已接入：claude-code · 最近一次 2026/09/02 10:00');
    expect(t).not.toContain(BYO.title);
  });
});

/* ── J11 / J12 对话页提示条 ────────────────────────────── */

describe('J11 没接入的人看不到提示条', () => {
  it('渲染成空串——不是空 div，也不是留白', () => {
    expect(ssr(<ByoAgentNotice />)).toBe('');
  });
});

describe('J12 已接入才提示，而且不阻断', () => {
  beforeEach(() => {
    Object.assign(conn, { connected: true, name: 'claude-code', when: '2026/09/02 10:00' });
  });

  it('说清是哪个助手、那边不扣、这里按轮计', () => {
    const t = text(ssr(<ByoAgentNotice />));
    expect(t).toContain('你已接入自己的 agent（claude-code）');
    expect(t).toContain('在你自己的 agent 上对话不扣公道值');
    expect(t).toContain('这里对话按轮计');
  });

  it('不阻断：没有禁用态、没有模态框', () => {
    // 「不阻断」的可验形态：这一条不许长出 disabled 的控件，也不许是个要先关掉的对话框
    const html = ssr(<ByoAgentNotice />);
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('role="dialog"');
  });

  it('低调模式：换中性词并进糊层', () => {
    ui.discreet = true;
    const html = ssr(<ByoAgentNotice />);
    expect(html).toContain('data-veil');
    expect(text(html)).toContain('不扣额度');
    expect(text(html)).not.toContain('公道值');
  });

  it('挂在对话页上，不是写完没接线', () => {
    // 变异核：把 Workbench 里那一行 <ByoAgentNotice /> 删掉，这条红。
    // 组件自己测得再全，没挂上去等于没做——而"没挂"在页面上就是"什么都没有"。
    const wb = readFileSync(join(process.cwd(), 'src/app/(app)/case/[id]/_components/Workbench.tsx'), 'utf8');
    expect(wb).toContain('<ByoAgentNotice />');
  });
});
