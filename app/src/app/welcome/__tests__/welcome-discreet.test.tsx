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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BYO, byoBillingLine } from '@/app/_ui/byoAgent';
import { CASE_WORDS, NEUTRAL_WORD } from '@/app/_ui/neutral';
import { DiscreetVeil } from '@/app/_ui/veil';
import { allText, unveiledText, visibleText } from '@/app/_ui/__tests__/unveiled';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const WelcomePage = (await import('../page')).default;
const WelcomeLayout = (await import('../layout')).default;
const html = () => renderToStaticMarkup(<WelcomePage />);

const NORMAL_BILLING = byoBillingLine({ credit: '公道值', watch: '守望', discreet: false });
const DISCREET_BILLING = byoBillingLine({
  credit: NEUTRAL_WORD.credits,
  watch: NEUTRAL_WORD.watch,
  discreet: true,
});

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


/**
 * 揭得开，且揭开看到的是低调那一句。
 *
 * 【为什么这两条要一起立】糊层与手势层是一件事的两半：
 * 只有糊层 = 糊死了揭不开（这一页原先就是这样，注册完那一屏的接入卡再也读不到）；
 * 只有手势层而底下摆的是常规变体 = 按住那一眼露出「案件」，
 * 而低调模式的承诺正是"按住看清的那一眼也不许出现案情词"。
 */
describe('揭开手势存在：这一页糊了要能按住看清', () => {
  /** 在 layout 的元素树里找 DiscreetVeil 本尊（认组件身份，不认名字字符串） */
  const hasVeil = (node: ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(hasVeil);
    if (!isValidElement(node)) return false;
    if (node.type === DiscreetVeil) return true;
    return hasVeil((node.props as { children?: ReactNode }).children);
  };

  it('/welcome 的 layout 挂着 AppShell 用的那一个 DiscreetVeil', () => {
    const tree = WelcomeLayout({ children: <div /> }) as ReactElement;
    expect(
      hasVeil(tree),
      '缺什么：/welcome 没有按住看清的手势层。\n' +
        '为什么缺：糊层是纯 CSS（globals.css 的 html[data-discreet=\'1\'] [data-veil]），' +
        '揭开却要文档级的指针委托（_ui/veil 的 DiscreetVeil）。少了它，这一屏是**糊死的**——' +
        '排版正常、没有任何报错，只是接入卡那两段再也读不到。\n' +
        '怎么办：在 welcome/layout.tsx 里挂 <DiscreetVeil />（就是 AppShell 用的那一个，' +
        '别另抄一份手势逻辑）。挂在 layout 上，page.tsx 才留得住 server component 的身份。',
    ).toBe(true);
  });

  it('页面本身仍是能裸渲的 server component——手势层不许挪进 page', () => {
    // 挪进去 landing-byo.test 的 J8（裸渲这一页、没有 DiscreetProvider）当场炸。
    expect(() => html()).not.toThrow();
  });
});

describe('低调下可见的是低调变体：口径与壳层一致', () => {
  it('低调模式看得到的是「对话与分析」，看不到带「案件」的那句', () => {
    const seen = visibleText(html(), { discreet: true });
    expect(seen, '低调变体没渲染出来').toContain(DISCREET_BILLING.replace(/\s+/g, ''));
    expect(
      seen,
      '缺什么：低调模式下这一页摆的仍是常规计费句（带「案件分析」「公道值」「守望」）。\n' +
        '为什么缺：糊层按住就能看清，看清的那一眼读到的必须已经是低调变体；' +
        '壳层糊着、指尖一按却露出「案件」，两处口径打架比一处不写更糟。\n' +
        '怎么办：两种变体都渲染，常规那句挂 .discreet-hide、低调那句挂 .discreet-only，' +
        '显隐交给 globals.css 的 html[data-discreet=\'1\']。',
    ).not.toContain(NORMAL_BILLING.replace(/\s+/g, ''));
  });

  it('反向对照：常规模式看得到的是常规变体，低调那句收着', () => {
    // 少了这条，把两句都写成低调变体也全绿——那时常规模式也不再说「公道值」，
    // 而「公道值」是用户在余额卡、流水、充值页看到的同一个词。
    const seen = visibleText(html(), { discreet: false });
    expect(seen).toContain(NORMAL_BILLING.replace(/\s+/g, ''));
    expect(seen).not.toContain(DISCREET_BILLING.replace(/\s+/g, ''));
  });

  it('那两个类的 CSS 规则确实在 globals.css 里——没有它们，两句会同时显示', () => {
    // 上面两条按类名推断「看得见什么」。规则被删掉的那一版，两条照样绿，
    // 而屏幕上两句话叠着一起出现。
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/\.discreet-only\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/html\[data-discreet='1'\]\s+\.discreet-only\s*\{[^}]*display:/);
    expect(css).toMatch(/html\[data-discreet='1'\]\s+\.discreet-hide\s*\{[^}]*display:\s*none/);
  });
});
