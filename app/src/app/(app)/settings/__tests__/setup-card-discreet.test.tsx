/**
 * 省钱引导**不进低调模式例外区**：低调模式下这张卡整体折叠成中性的「接入配置」，
 * 引导文案跟着一起收起来——它里面有「公道值」这类字样，露出来就是一处泄漏。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({ useDiscreet: () => ({ discreet: ui.discreet }) }));
vi.mock('../_components/useAgentSetup', () => ({
  useAgentSetup: () => ({ info: null, loading: false, error: null, unauthorized: true }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { AgentSetupCard } = await import('../_components/AgentSetupCard');
const HOOK = '用你自己的助手干活，能省下公道值';

describe('MCP 省钱引导', () => {
  it('常规模式下出现在接入卡里', () => {
    ui.discreet = false;
    expect(renderToStaticMarkup(<AgentSetupCard />)).toContain(HOOK);
  });

  it('低调模式下整卡折叠，引导跟着收起来', () => {
    ui.discreet = true;
    const html = renderToStaticMarkup(<AgentSetupCard />);
    expect(html).not.toContain(HOOK);
    expect(html).not.toContain('公道值'); // 卡里任何一处都不许露出这三个字
    ui.discreet = false;
  });
});
