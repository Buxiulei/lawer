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

  /*
   * 「当前密钥」那一小节是本单新加的，它必须**跟着这张卡一起折叠**。
   * 加在 DiscreetCollapse 外面照样能通过上面两条（那两条只认「公道值」与引导语），
   * 而低调模式下屏幕上会常驻一段写着「当前密钥」的东西——旁人一眼就看得出
   * 这台手机上挂着个要用密钥连的服务。
   */
  it('新加的「当前密钥」小节也在折叠里，不是摆在外面', () => {
    ui.discreet = false;
    expect(renderToStaticMarkup(<AgentSetupCard />)).toContain('当前密钥'); // 正对照
    ui.discreet = true;
    expect(renderToStaticMarkup(<AgentSetupCard />)).not.toContain('当前密钥');
    ui.discreet = false;
  });
});
