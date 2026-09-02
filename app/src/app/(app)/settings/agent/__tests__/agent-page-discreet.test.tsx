/**
 * /settings/agent 的低调模式泄漏守卫——**按页面锁，不按组件名锁**。
 *
 * 【为什么必须按页面锁】同一份接入话术在设置页那张卡上早就折叠好了，由
 * settings/__tests__/setup-card-discreet.test.tsx 钉着。但那条守卫是
 * `import { AgentSetupCard }` 起头的：它守的是那个组件，不是「屏幕上有没有案情词」。
 * 本单把同样的话术搬到一个新页面时，旧守卫全绿，而低调模式下这一页把
 * 「请帮我接入「土八鼠」法律陪跑平台（我的劳动仲裁案件档案库）」整块摆在屏幕上——
 * 入口卡刚被改名成中性的「接入你自己的助手」，点一下就全露了。
 *
 * 所以这一组渲染的是**页面**（app/(app)/settings/agent/page.tsx 的默认导出），
 * 断言的是「这一屏上还清晰可读的字里有没有案情词」，不认识任何组件名：
 * 以后往这一页加任何东西，加的人不需要知道有这条守卫，红了自然会来读。
 *
 * 词表从 _ui/neutral 里 import。手抄一份的那天，抄漏的那个词会让这条守卫
 * 绿着，而屏幕上照样写着「仲裁」。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO } from '@/app/_ui/byoAgent';
import { CASE_WORDS } from '@/app/_ui/neutral';

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
// CodeBlock 要 ToastProvider；这一组要的是**话术真的被渲染出来**（否则守卫落在空集上永远绿），
// 所以顶掉 toast 而不是绕开 CodeBlock。
vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));
// 地址给全，让 SetupPrompt 渲染出完整话术——它才是这一页最大的一处泄漏面。
vi.mock('../../_components/useAgentSetup', () => ({
  useAgentSetup: () => ({
    info: {
      mcp_url: 'https://example.test/api/mcp',
      api_base: 'https://example.test/api/v1',
      manifest_url: 'https://example.test/api/manifest',
      tools: [{ name: 'case_read', description: '读档案' }],
    },
    loading: false,
    error: null,
    unauthorized: false,
  }),
}));

const AgentConnectPage = (await import('../page')).default;

/**
 * 取出所有**没有** data-veil 的可见文字——即「不按住也读得到的那些字」。
 * 配对标签整棵子树剔除（同 dashboard-discreet.test 的做法）：正则一把梭会停在
 * 第一个闭合标签上，遇到嵌套少剔一截，于是守卫看起来在守、其实漏。
 */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

function unveiledText(html: string): string {
  const tokens = html.split(/(<[^>]+>)/);
  const out: string[] = [];
  let skipDepth = 0;
  const stack: string[] = [];

  for (const tok of tokens) {
    if (!tok) continue;
    if (!tok.startsWith('<')) {
      if (skipDepth === 0) out.push(tok);
      continue;
    }
    const closing = tok.startsWith('</');
    const name = (tok.match(/^<\/?([a-zA-Z0-9]+)/)?.[1] ?? '').toLowerCase();
    const selfClosing = tok.endsWith('/>') || VOID_TAGS.has(name);

    if (closing) {
      stack.pop();
      if (skipDepth > 0 && stack.length < skipDepth) skipDepth = 0;
      continue;
    }
    if (selfClosing) continue;
    stack.push(name);
    if (skipDepth === 0 && /\sdata-veil\b/.test(tok)) skipDepth = stack.length;
  }
  return out.join('').replace(/\s+/g, '');
}

const html = () => renderToStaticMarkup(<AgentConnectPage />);
const allText = (h: string) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, '');

beforeEach(() => {
  ui.discreet = false;
});

describe('低调模式：这一屏上没有一个清晰可读的案情词', () => {
  it('词表逐词点名——劳动 / 仲裁 / 案件 / 维权 / 证据 / 文书 / 土八鼠', () => {
    ui.discreet = true;
    const clear = unveiledText(html());
    for (const word of CASE_WORDS) {
      expect(
        clear.includes(word),
        `缺什么：低调模式下 /settings/agent 上有一处明文写着「${word}」。\n` +
          `为什么缺：这一页是四处入口的落地页，而低调模式下那张入口卡显示的是中性的` +
          `「接入你自己的助手」——点进来看见案情词，等于入口改名白改，旁人一眼就看得出` +
          `这台手机在办什么事。这个错的形态是静默的：排版正常、没有任何报错。\n` +
          `怎么办：那一整块要原样复制的内容（如接入话术）用 _ui/DiscreetCollapse 折叠；` +
          `普通正文加 data-veil 进糊层（按住能看清）；壳层用词走 _ui/neutral 的 NEUTRAL_WORD。`,
      ).toBe(false);
    }
  });

  it('计费口径那段仍在糊层里——它是这一页唯一一处 data-veil 的老住户', () => {
    ui.discreet = true;
    expect(allText(html())).toContain('按用量收'); // 正对照：这句确实渲染了
    expect(unveiledText(html())).not.toContain('按用量收');
  });
});

describe('反向对照：常规模式下这些话原样在屏幕上', () => {
  /*
   * 少了这一组，把整页删空、或把话术那块在两种模式下都折叠起来，上面那组照样全绿——
   * 那时守住的是一个没有内容的页面。
   */
  it('常规模式下接入话术不折叠，整段清晰可读', () => {
    ui.discreet = false;
    const clear = unveiledText(html());
    expect(clear).toContain('请帮我接入「土八鼠」法律陪跑平台（我的劳动仲裁案件档案库）。');
    expect(clear).toContain('起草文书'); // 话术里的能力清单
    // 页面标题在常规模式下是带案情意味的那句，不是低调用的中性标题
    // unveiledText 已抹掉空白，比对时把标题也抹一遍
    expect(clear).toContain(BYO.title.replace(/\s+/g, ''));
    expect(clear).not.toContain(BYO.titleNeutral.replace(/\s+/g, ''));
  });

  it('进糊层的那两段两种模式下都还在 DOM 里——糊住不等于删掉，按住就能看清', () => {
    for (const discreet of [false, true]) {
      ui.discreet = discreet;
      const t = allText(html());
      expect(t, `discreet=${discreet}`).toContain('起草文书'); // BYO.lead
      expect(t, `discreet=${discreet}`).toContain('读一下我的案件档案'); // 第四步说明
    }
  });
});
