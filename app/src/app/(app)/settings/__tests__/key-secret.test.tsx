/**
 * 「话术里填的是真密钥」这条链的守卫。
 *
 * 【为什么要守】这一单推翻的是「明文只显示一次」。推翻得不彻底的形态是：
 * 后端已经能把明文取回来了，页面却还在渲染占位符与「只显示这一次」——
 * 排版正常、没有任何报错，而用户照旧为了换台设备去吊销重建。
 * 所以这里钉三层：挑哪一把（pickManageable）、三种态各自说什么（CurrentKey）、
 * 拿到明文之后话术里到底填没填（setupPrompt）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { KEY_PLACEHOLDER, setupPrompt } from '../_components/agentSetup';
import {
  pickManageable,
  type AgentKeySecret,
  type KeyBrief,
} from '../_components/useAgentKeySecret';

vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { CurrentKey } = await import('../_components/CurrentKey');

const brief = (over: Partial<KeyBrief>): KeyBrief => ({
  id: 1,
  name: 'k',
  enabled: true,
  last_used_at: null,
  viewable: true,
  ...over,
});

const secretOf = (state: AgentKeySecret['state']): AgentKeySecret => ({
  state,
  rotate: async () => {},
  rotating: false,
  adopt: () => {},
});

const text = (node: React.ReactElement) =>
  renderToStaticMarkup(node).replace(/<[^>]+>/g, '');

describe('挑哪一把填进话术', () => {
  it('一把都没有 → null', () => {
    expect(pickManageable([])).toBeNull();
  });

  it('已吊销的不算——它填进话术粘过去就是 401', () => {
    expect(pickManageable([brief({ enabled: false, last_used_at: '2026-09-01 10:00:00' })])).toBeNull();
  });

  it('用过的优先，多把用过取最近那把', () => {
    const got = pickManageable([
      brief({ id: 3, name: '新建没用过' }),
      brief({ id: 2, name: '旧的用过', last_used_at: '2026-08-01 10:00:00' }),
      brief({ id: 1, name: '最近用过', last_used_at: '2026-09-01 10:00:00' }),
    ]);
    expect(got!.name).toBe('最近用过');
  });

  /*
   * 【与 _ui/useConnectedAgent.pickConnected 恰好相反的那一格】那边问「接没接上」，
   * 从没用过的一律不算；这边问「该把哪一把填进话术」，一把刚生成、还没粘出去的
   * 正是最该填的那把。合并成一个函数必然要牺牲其中一边。
   */
  it('都没用过就取列表第一条（GET /keys 按 id DESC，即最近创建的那把）', () => {
    const got = pickManageable([brief({ id: 9, name: '最近建的' }), brief({ id: 2, name: '早先建的' })]);
    expect(got!.name).toBe('最近建的');
  });
});

describe('当前密钥这一小节', () => {
  it('拿到明文：把它摆出来，并说明忘了可以回来看', () => {
    const t = text(<CurrentKey secret={secretOf({ kind: 'ready', id: 1, name: '我的 Claude', secret: 'sk-plain-abc' })} />);
    expect(t).toContain('sk-plain-abc');
    expect(t).toContain('我的 Claude');
    expect(t).toContain('忘了随时回来看');
    expect(t).toContain('轮换密钥');
    // 反向对照：不许还挂着那句已经不成立的话
    expect(t).not.toContain('只显示这一次');
    expect(t).not.toContain('不会再次显示');
  });

  it('存量旧密钥：照实说看不到，出路是轮换而不是「知道了」', () => {
    const t = text(<CurrentKey secret={secretOf({ kind: 'legacy', id: 1, name: '老钥匙' })} />);
    expect(t).toContain('看不到明文');
    expect(t).toContain('轮换密钥'); // 唯一的真出路
  });

  it('取不到明文：把服务端那句自述型错误原样端出来，不包一层「出错了」', () => {
    const msg = '缺什么：服务端的加解密主密钥这次不可用……怎么办：你这把 key 本身完全没事。';
    const t = text(<CurrentKey secret={secretOf({ kind: 'error', id: 1, name: 'k', message: msg })} />);
    expect(t).toContain(msg);
  });

  it('一把都没有：给去生成的路；接入指南自己就是那条路，可以关掉这条链接', () => {
    expect(text(<CurrentKey secret={secretOf({ kind: 'none' })} />)).toContain('照指南生成一把');
    expect(
      text(<CurrentKey secret={secretOf({ kind: 'none' })} offerIssueLink={false} />),
    ).not.toContain('照指南生成一把');
  });
});

describe('话术里填的是真密钥', () => {
  const VARS = {
    mcp_url: 'https://example.test/api/mcp',
    api_base: 'https://example.test/api/v1',
    manifest_url: 'https://example.test/api/manifest',
    skill_url: 'https://example.test/skill/SKILL.md',
  };

  it('有明文时占位符一个都不剩', () => {
    const out = setupPrompt('general', { ...VARS, apiKey: 'sk-plain-abc' });
    expect(out).toContain('sk-plain-abc');
    expect(out).not.toContain(KEY_PLACEHOLDER);
  });

  /*
   * 正对照：没明文时仍然给占位符。少了这条，把 KEY_PLACEHOLDER 删成空串
   * 上面那条照样绿，而那时话术里是个空的 Bearer——粘过去必然 401。
   */
  it('没明文时才落到占位符，且不会出现空的 Bearer', () => {
    const out = setupPrompt('general', VARS);
    expect(out).toContain(KEY_PLACEHOLDER);
    expect(out).not.toMatch(/Bearer\s*$/m);
  });
});

/* ── 单一入口 ─────────────────────────────────────────── */

describe('取明文只有一个入口', () => {
  const SRC = join(process.cwd(), 'src');
  const SURFACES = [
    'app/(app)/settings/_components/AgentSetupCard.tsx',
    'app/(app)/settings/agent/_components/ConnectGuide.tsx',
  ];

  /*
   * 两处屏幕要回答同一个问题：这个人现在那把 key 的明文是什么。
   * 各写各的取数逻辑，形态是一处显示真密钥、另一处还在给占位符——两处都很正常。
   * 所以这里钉：两处都走 useAgentKeySecret，谁都不许自己去打 /keys/{id}/secret。
   */
  it('两张面都用 useAgentKeySecret，没有一处自己打那条接口', () => {
    for (const rel of SURFACES) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text, rel).toContain('useAgentKeySecret');
      expect(text, rel).not.toContain('/secret');
      expect(text, rel).not.toContain('/rotate');
    }
    // 正对照：那条接口确实在 hook 里被调，否则上面三条落在"谁都没调"的空集上
    const hook = readFileSync(join(SRC, 'app/(app)/settings/_components/useAgentKeySecret.ts'), 'utf8');
    expect(hook).toContain('/secret');
    expect(hook).toContain('/rotate');
  });
});
