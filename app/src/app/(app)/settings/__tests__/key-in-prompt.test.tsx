/**
 * 「真密钥到底有没有落进屏幕上那段话术里」——端到端的那一小段。
 *
 * 【为什么单开一组】key-secret.test 钉的是「取数挑对了没有」与「话术函数填对了没有」，
 * 两头都绿，中间那根线断了照样全绿：AgentSetupCard 把 apiKey 忘了传、
 * ConnectGuide 只认「本次刚生成的那把」。那时用户看到的仍是占位符，
 * 而所有单元判据都在说一切正常。所以这里直接渲染那两张面，扫最终文本。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const SECRET = 'sk-plain-in-prompt-0001';
const INFO = {
  mcp_url: 'https://example.test/api/mcp',
  api_base: 'https://example.test/api/v1',
  manifest_url: 'https://example.test/api/manifest',
  skill_url: 'https://example.test/skill/SKILL.md',
  tools: [{ name: 'case_get', description: '读档案' }],
};

/** 密钥取到了的稳定态。两张面都吃它。 */
const keySecret = {
  state: { kind: 'ready' as const, id: 7, name: '我的 Claude', secret: SECRET },
  rotate: async () => {},
  rotating: false,
  adopt: () => {},
};

vi.mock('@/app/_ui/discreet', () => ({ useDiscreet: () => ({ discreet: false, toggle: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/app/_ui/api', () => ({
  apiFetch: () => Promise.reject(new Error('测试不发请求')),
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));
vi.mock('../_components/useAgentSetup', () => ({
  useAgentSetup: () => ({ info: INFO, loading: false, error: null, unauthorized: false }),
}));
vi.mock('../_components/useAgentKeySecret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_components/useAgentKeySecret')>()),
  useAgentKeySecret: () => keySecret,
}));
vi.mock('@/app/_ui/useConnectedAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/useConnectedAgent')>()),
  useConnectedAgent: () => ({
    loading: false,
    connected: false,
    name: '',
    nameIsKeyName: false,
    when: '',
  }),
}));

const { AgentSetupCard } = await import('../_components/AgentSetupCard');
const { ConnectGuide } = await import('../agent/_components/ConnectGuide');

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('话术里落的是真密钥', () => {
  it.each([
    ['设置页接入卡', <AgentSetupCard key="card" secret={keySecret} />],
    ['接入指南', <ConnectGuide key="guide" />],
  ])('%s', (_label, node) => {
    const out = html(node as React.ReactElement);
    expect(out).toContain(SECRET);
    // 占位符与那句已经不成立的话，一处都不许剩
    expect(out).not.toContain('&lt;粘贴你生成时保存的密钥&gt;');
    expect(out).not.toContain('密钥只在生成那一次显示');
  });

  it('话术里同时带着 skill 第一步——两样都得在同一段里', () => {
    const out = html(<AgentSetupCard secret={keySecret} />);
    expect(out).toContain(INFO.skill_url);
    expect(out).toContain('【第一步，先做这个】');
  });
});
