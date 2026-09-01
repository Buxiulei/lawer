/**
 * 「我的」页上的兑换码入口。
 *
 * 两件事要钉住：
 * ① 入口**在登录后出现、未登录时不出现**——没账户可到账时先摆个输入框，
 *    等于让人填完才被告知要先登录。
 * ② 低调模式不泄漏：这一段跟着换中性词，且不带任何案件字样。
 *    这一页是用户在别人眼皮底下最可能打开的一页（看余额），新加的文案漏换一处就是一次泄漏。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

const { AccountView } = await import('../_components/AccountView');
const { RedeemPanel } = await import('../_components/RedeemPanel');

const renderAccount = (signedIn: boolean) => {
  auth.signedIn = signedIn;
  const html = renderToStaticMarkup(<AccountView />);
  auth.signedIn = true;
  return html;
};

const renderPanel = (discreet: boolean) => {
  ui.discreet = discreet;
  const html = renderToStaticMarkup(<RedeemPanel onRedeemed={() => {}} />);
  ui.discreet = false;
  return html;
};

describe('入口', () => {
  it('登录后「我的」页上有兑换码输入框与按钮', () => {
    const html = renderAccount(true);
    expect(html).toContain('兑换码');
    expect(html).toContain('aria-label="兑换码"');
    expect(html).toContain('>兑换<');
  });

  it('未登录时不出现——没有账户可以到账', () => {
    expect(renderAccount(false)).not.toContain('aria-label="兑换码"');
  });

  it('说清「一条码只能用一次」——兑完再拿同一条码试的人得知道这是设计如此', () => {
    expect(renderAccount(true)).toContain('一条码只能用一次');
  });
});

describe('低调模式不泄漏', () => {
  it('整段不留「公道值」', () => {
    expect(renderPanel(true)).not.toContain('公道值');
  });

  it('不带任何案件字样', () => {
    const html = renderPanel(true);
    for (const leak of ['仲裁', '案件', '劳动', '维权', '裁员']) {
      expect(html).not.toContain(leak);
    }
  });

  it('常规模式下照旧说「公道值」—— 换词只该发生在低调模式', () => {
    // 反向对照：少了这条，把 creditWord 写死成「额度」也能让上面那条绿
    const html = renderPanel(false);
    expect(html).toContain('公道值');
    expect(html).not.toContain('额度');
  });
});
