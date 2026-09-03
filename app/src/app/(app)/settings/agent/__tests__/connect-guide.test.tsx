/**
 * 一页式接入指南。
 *
 * 【这一页存在的理由】原来接入这件事散在两张卡里：ApiKeysCard 管密钥、AgentSetupCard 管配置，
 * 两张都假设你已经知道自己在干什么，而且**没有任何地方告诉你「接上了没有」**。
 * 所以这里守两件事：四步在不在、以及"接没接上"这个判据的名字是从哪来的。
 *
 * 【J13 名字不许编】客户端没自报名字时，页面显示的是**用户自己给钥匙起的名**。
 * 不说明这一点，用户会以为我们认出了他的助手——那是一句没人会去核对的假话。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO, BYO_NAME_IS_KEY_NAME, byoBillingLine } from '@/app/_ui/byoAgent';
import type { ApiKeyBrief, ConnectedAgent } from '@/app/_ui/useConnectedAgent';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/app/_ui/api', () => ({
  apiFetch: () => Promise.reject(new Error('测试不发请求')),
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));
// 地址取不到就不渲染话术那块（SetupPrompt 里的 CodeBlock 要 ToastProvider）。
// 这一组测的是四步骨架与已接入态，不是话术——话术归 settings/__tests__/agentSetup.test.ts。
vi.mock('../../_components/useAgentSetup', () => ({
  useAgentSetup: () => ({ info: null, loading: false, error: '测试不取地址', unauthorized: false }),
}));

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

const { ConnectGuide } = await import('../_components/ConnectGuide');
const { pickConnected } = await import('@/app/_ui/useConnectedAgent');

const ssr = () => renderToStaticMarkup(<ConnectGuide />);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  ui.discreet = false;
  Object.assign(conn, { loading: false, connected: false, name: '', nameIsKeyName: false, when: '' });
});

describe('四步骨架', () => {
  it('生成密钥 / 复制配置 / 粘到助手 / 验证连通，一步都不少', () => {
    const t = text(ssr());
    for (const step of ['第一步', '第二步', '第三步', '第四步']) expect(t).toContain(step);
    // 第一步从「生成一把密钥」改名成「拿到你的密钥」：密钥现在取得回来，
    // 已经有一把的人进这一页不该被要求再生成一把（那样两把 key 挂着，谁也不知道哪把在用）
    expect(t).toContain('拿到你的密钥');
    expect(t).toContain('复制配置');
    expect(t).toContain('粘到你的助手里');
    expect(t).toContain('验一下接上没有');
  });

  it('计费口径印在开头，不是等人翻到底', () => {
    expect(text(ssr())).toContain(
      byoBillingLine({ credit: '公道值', watch: '守望', discreet: false }),
    );
  });

  it('低调模式：标题中性、口径换中性词', () => {
    ui.discreet = true;
    const t = text(ssr());
    expect(t).toContain(BYO.titleNeutral);
    expect(t).toContain(byoBillingLine({ credit: '额度', watch: '关注', discreet: true }));
    expect(t).not.toContain('公道值');
  });
});

describe('J13 名字来源不许编', () => {
  it('客户端没自报名字：显示钥匙名，并说明那是钥匙名', () => {
    Object.assign(conn, {
      connected: true,
      name: '我的 Claude',
      nameIsKeyName: true,
      when: '2026/09/02 10:00',
    });
    const t = text(ssr());
    expect(t).toContain('已接入：我的 Claude · 最近一次 2026/09/02 10:00');
    expect(t).toContain(BYO_NAME_IS_KEY_NAME);
  });

  it('客户端自报了名字：显示它，不再多那句解释', () => {
    Object.assign(conn, {
      connected: true,
      name: 'claude-code',
      nameIsKeyName: false,
      when: '2026/09/02 10:00',
    });
    const t = text(ssr());
    expect(t).toContain('已接入：claude-code');
    expect(t).not.toContain(BYO_NAME_IS_KEY_NAME);
  });

  it('没接上就没有这条横幅——生成了钥匙却没粘进去，跟没接是同一件事', () => {
    expect(text(ssr())).not.toContain('已接入：');
  });
});

describe('「接没接上」的判据：钥匙被用过，不是钥匙存在', () => {
  it('从没用过的钥匙不算接上', () => {
    expect(
      pickConnected([{ id: 1, name: '我的 Claude', enabled: true, last_used_at: null }]).connected,
    ).toBe(false);
  });

  it('已吊销的钥匙不算接上，哪怕它用过', () => {
    expect(
      pickConnected([
        { id: 1, name: '旧的', enabled: false, last_used_at: '2026-09-01 10:00:00' },
      ]).connected,
    ).toBe(false);
  });

  it('多把用过的取最近那把', () => {
    const two: ApiKeyBrief[] = [
      { id: 1, name: '旧的', enabled: true, last_used_at: '2026-08-01 10:00:00' },
      { id: 2, name: '新的', enabled: true, last_used_at: '2026-09-01 10:00:00' },
    ];
    const got = pickConnected(two);
    expect(got.connected).toBe(true);
    expect(got.name).toBe('新的');
  });

  it('client_name 有值就用它，并标明不是钥匙名', () => {
    const got = pickConnected([
      { id: 1, name: '我的 Claude', enabled: true, last_used_at: '2026-09-01 10:00:00', client_name: 'claude-code' },
    ]);
    expect(got.name).toBe('claude-code');
    expect(got.nameIsKeyName).toBe(false);
  });

  it('client_name 为空白串时**不当作名字**——空格不是自报名', () => {
    const got = pickConnected([
      { id: 1, name: '我的 Claude', enabled: true, last_used_at: '2026-09-01 10:00:00', client_name: '   ' },
    ]);
    expect(got.name).toBe('我的 Claude');
    expect(got.nameIsKeyName).toBe(true);
  });
});

describe('验证这一步不需要新端点', () => {
  it('判据落在 api_keys.last_used_at 上，而它由 resolveIdentity 在每次用 key 时写', () => {
    // 结构守卫：哪天有人把 touchApiKeyLastUsed 从 resolveIdentity 里拿掉，
    // 「我接好了，检查一下」会永远超时——而那条超时提示读起来像是用户配错了。
    const identity = readFileSync(join(process.cwd(), 'src/lib/auth/identity.ts'), 'utf8');
    expect(identity).toMatch(/touchApiKeyLastUsed\s*\(/);
  });
});
