/**
 * /welcome 的低调模式泄漏守卫——**按页面锁，不按组件名锁**。
 *
 * 【为什么这一页需要自己的守卫】接入卡的话术在设置页那张卡上早就折叠好了
 * （setup-card-discreet.test），在 /settings/agent 上也被页面级守卫钉着
 * （agent-page-discreet.test）。但那两条守的是各自那一处：本支把 BYO.lead
 * 与 byoBillingLine 的常规变体原样搬到注册完成页，两条旧守卫全绿，而低调模式下
 * 这一屏把「传证据…起草文书」「对话与案件分析」摊在屏幕上——注册刚走完、
 * 手机还在别人眼皮底下的那一屏。
 *
 * 所以这一组渲染的是**页面**（welcome/page.tsx 的默认导出），断言的是
 * 「这一屏上还清晰可读的字里有没有案情词」，不认识任何组件名：以后往这一页
 * 加任何东西，加的人不需要知道有这条守卫，红了自然会来读。
 *
 * 词表与取字器都是 import 来的，不手抄：抄漏一个词的那页看起来跟守住了的页面
 * 一模一样——守卫绿着，屏幕上照样写着「仲裁」。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BYO, byoBillingLine } from '@/app/_ui/byoAgent';
import { CASE_WORDS } from '@/app/_ui/neutral';
import { allText, unveiledText } from '@/app/_ui/__tests__/unveiled';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const WelcomePage = (await import('../page')).default;
const html = () => renderToStaticMarkup(<WelcomePage />);

const NORMAL_BILLING = byoBillingLine({ credit: '公道值', watch: '守望', discreet: false });

describe('低调模式：/welcome 这一屏上没有一个清晰可读的案情词', () => {
  it('词表逐词点名——劳动 / 仲裁 / 案件 / 维权 / 证据 / 文书 / 土八鼠', () => {
    const clear = unveiledText(html());
    for (const word of CASE_WORDS) {
      expect(
        clear.includes(word),
        `缺什么：低调模式下 /welcome 上有一处明文写着「${word}」。\n` +
          `为什么缺：这是双验证走完落地的第一屏，人往往就在办公室里、手机还摊着。` +
          `这一页是裸布局、server component，取不到 useDiscreet——但糊层是纯 CSS` +
          `（globals.css 的 html[data-discreet='1'] [data-veil]），属性写上就生效。` +
          `这个错的形态是静默的：排版正常、没有任何报错。\n` +
          `怎么办：把含案情词的那一块加上 data-veil=""（整块，别只糊一半）；` +
          `壳层用词走 _ui/neutral 的 NEUTRAL_WORD；要原样复制的长文用 _ui/DiscreetCollapse。`,
      ).toBe(false);
    }
  });
});

describe('反向对照：这些话确实在这一页上，只是进了糊层', () => {
  /*
   * 少了这一组，把整页删空、或把接入卡整个拿掉，上面那条照样全绿——
   * 那时守住的是一个没有内容的页面。
   */
  it('接入卡的引导语与计费口径都还在 DOM 里——糊住不等于删掉，按住就能看清', () => {
    const t = allText(html());
    expect(t).toContain(BYO.lead.replace(/\s+/g, ''));
    expect(t).toContain(NORMAL_BILLING.replace(/\s+/g, ''));
    expect(t).toContain('土八鼠');
  });

  it('常规模式下读得到的那部分仍在明文里：标题、CTA、不影响那句', () => {
    // 糊层不是「把整页糊掉」——糊过头这一屏就没法用了。
    const clear = unveiledText(html());
    expect(clear).toContain('档案已创建');
    expect(clear).toContain('开始首诊');
    expect(clear).toContain(BYO.title.replace(/\s+/g, ''));
    expect(clear).toContain(BYO.cta.replace(/\s+/g, ''));
  });
});
