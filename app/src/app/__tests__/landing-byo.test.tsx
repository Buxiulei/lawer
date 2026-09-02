/**
 * 「用你自己的 agent」在**未登录两页**上的入口：主页与注册完成页。
 *
 * 【为什么不是 toContain 就够】这条入口的产品要求是「排在网页对话之上或并列首位」——
 * 位置就是承诺本身。只断言"页面里有这段字"的话，把整块挪到页脚照样绿，
 * 而挪到页脚的那一版**看起来完全正常**：字都在，链接也能点。
 * 所以主页那条比的是**下标先后**，欢迎页那条比的是它与「开始首诊」同处一块。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BYO, BYO_GUIDE_HREF, byoBillingLine } from '../_ui/byoAgent';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/_ui/auth', () => ({
  useAuthToken: () => null,
  useSignedIn: () => false,
}));

const { default: LandingPage } = await import('../page');
const { default: WelcomePage } = await import('../welcome/page');

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const NORMAL_LINE = byoBillingLine({ credit: '公道值', watch: '守望', discreet: false });

describe('J7 主页：卷〇排在卷一之前', () => {
  const html = () => renderToStaticMarkup(<LandingPage />);

  it('卡在页面上，且下标早于卷一的标题', () => {
    const h = html();
    // 认的是 BYO.lead 本身（唯一文案入口里的那一段），不是页面上另写的小标题——
    // 小标题改一个字这条就该照样绿，卡整块被挪走才该红
    const byo = h.indexOf(BYO.lead);
    const juan1 = h.indexOf('几分钟后，你手里有的东西');
    expect(byo, '主页上找不到卷〇那张卡（BYO.lead 没渲染出来）').toBeGreaterThan(-1);
    expect(juan1, '正对照：卷一的标题得先找得到，否则下面这条在 -1 上比大小').toBeGreaterThan(-1);
    expect(
      byo,
      `卷〇出现在下标 ${byo}，卷一在 ${juan1}——卷〇必须排在卷一之前。` +
        '位置就是承诺：排到示例文书之后，这条路就成了"顺带提一句"。',
    ).toBeLessThan(juan1);
  });

  it('卷标编号也跟着排：〇 在 一 之前', () => {
    const h = html();
    expect(h.indexOf('卷〇')).toBeGreaterThan(-1);
    expect(h.indexOf('卷〇')).toBeLessThan(h.indexOf('卷一'));
  });

  it('计费口径整句印在卡上，不是只写「不收费」', () => {
    expect(html()).toContain(NORMAL_LINE);
  });

  it('卷三的「收费」一句跟着改口径了——两处打架比一处不写更糟', () => {
    const h = html();
    expect(h).toContain('网页里的对话按轮消耗 token 计费（公道值）');
    expect(h).toContain('在你自己的 agent 上处理的对话与案件分析，我们不收公道值。');
  });
});

describe('J8 欢迎页：接入卡与「开始首诊」并列首位，且指向一页式指南', () => {
  const html = () => renderToStaticMarkup(<WelcomePage />);

  it('卡在页面上，指向 /settings/agent', () => {
    const h = html();
    expect(h).toContain(BYO.title);
    expect(h).toContain(`href="${BYO_GUIDE_HREF}"`);
  });

  it('并列首位：它与「开始首诊」之间没有别的按钮', () => {
    const h = html();
    // 从首诊按钮**的文字之后**量起，否则量进了首诊按钮自己那个 data-slot
    const intakeEnd = h.indexOf('开始首诊') + '开始首诊'.length;
    const byo = h.indexOf(BYO.title);
    expect(h.indexOf('开始首诊')).toBeGreaterThan(-1);
    expect(byo).toBeGreaterThan(intakeEnd);
    // 中间那段不许再冒出第三颗按钮——那会把这张卡挤成"其它选项"
    expect(h.slice(intakeEnd, byo)).not.toContain('data-slot="button"');
  });

  it('那个死锚点不许回来', () => {
    // /settings#api-keys 在全仓没有对应的 id="api-keys"，点了只会落到设置页顶部
    expect(html()).not.toContain('href="/settings#api-keys"');
  });

  it('计费口径整句印在卡上', () => {
    expect(html()).toContain(NORMAL_LINE);
  });
});
