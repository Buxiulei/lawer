/**
 * 「我的」页上那条接入指南入口。
 *
 * 【与 self-host-hint.test 的分工】那一组守的是余额卡里那段**省公道值引导**的字面
 * （它做的是一个可核对的事实断言，字面被九条钉死，本单一个字都没动）。
 * 这一组守的是新加的那条**入口**：怎么接、接没接上。两者都在余额卡里，都要在。
 *
 * 【为什么未登录时不许出现】没登录就没有钥匙可接，摆一条接入入口只是噪音——
 * 同 SelfHostHint 的既有纪律。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO, BYO_GUIDE_HREF, byoBillingLine } from '@/app/_ui/byoAgent';
import type { ConnectedAgent } from '@/app/_ui/useConnectedAgent';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const billingState = {
  data: { balance: 1200, ledgerSum: 1200, reconciled: true, complete: true, entries: [] },
  loading: false,
  error: null as string | null,
  unauthorized: false,
  hasMore: false,
  loadMore: () => {},
  refresh: () => {},
};
const meState = { data: null as null | Record<string, unknown>, loading: false, unauthorized: false };
const auth = { signedIn: true };
vi.mock('../_components/useBilling', () => ({ useBilling: () => billingState }));
vi.mock('../_components/useMe', () => ({ useMe: () => meState }));
vi.mock('@/app/_ui/auth', () => ({ useSignedIn: () => auth.signedIn }));

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

const { AccountView } = await import('../_components/AccountView');

const render = (discreet = false, signedIn = true) => {
  ui.discreet = discreet;
  auth.signedIn = signedIn;
  const html = renderToStaticMarkup(<AccountView />);
  ui.discreet = false;
  auth.signedIn = true;
  return html;
};
const text = (html: string) => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  Object.assign(conn, { loading: false, connected: false, name: '', nameIsKeyName: false, when: '' });
});

describe('J10 「我的」页：接入指南入口', () => {
  it('登录后出现，指向一页式指南', () => {
    const html = render();
    expect(html).toContain(`href="${BYO_GUIDE_HREF}"`);
    expect(text(html)).toContain(BYO.title);
  });

  it('带完整计费口径，不是只挂一个标题', () => {
    expect(text(render())).toContain(
      byoBillingLine({ credit: '公道值', watch: '守望', discreet: false }),
    );
  });

  it('没登录就不出现——没钥匙可接，摆着只是噪音', () => {
    const html = render(false, false);
    expect(html).not.toContain(`href="${BYO_GUIDE_HREF}"`);
    expect(text(html)).not.toContain(BYO.title);
  });

  it('低调模式：标题换中性词，这一条自己不留「公道值」', () => {
    const t = text(render(true));
    expect(t).toContain(BYO.titleNeutral);
    expect(t).toContain(byoBillingLine({ credit: '额度', watch: '关注', discreet: true }));
  });

  it('已接入后收成一行状态', () => {
    Object.assign(conn, { connected: true, name: 'claude-code', when: '2026/09/02 10:00' });
    const t = text(render());
    expect(t).toContain('已接入：claude-code · 最近一次 2026/09/02 10:00');
    expect(t).not.toContain(BYO.title);
  });

  it('没碰隔壁那段省公道值引导——它的字面归 self-host-hint.test 管', () => {
    // 正对照：两条都在。删掉任何一条，这一页就少了一半答案
    const t = text(render());
    expect(t).toContain('把这里接到你自己的 AI 助手上');
    expect(t).toContain(BYO.title);
  });
});
