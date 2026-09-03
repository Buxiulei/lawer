/**
 * 余额用尽这一屏（主理人 2026-09-03「拦」第 1 条的网页那半边）。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 服务端拦住了（402），页面这边有三种画法，其中两种是坏的：
 *  ① 当成普通失败画 StreamErrorCard ⇒ 上面写着「重试」，而重试一百次也不会有回答；
 *  ② 只挂一条提示、输入框照旧 ⇒ 用户接着打字、接着被弹回来，读起来像产品坏了；
 *  ③ 提示里说了「余额不足」却不说余额是多少、也不给出路 ⇒ 裸报错，让人自己去猜怎么办。
 * 三条判据分别钉住这三种。第四条钉低调模式：这一屏在旁人眼皮底下也要读起来无害。
 *
 * 【变异臂】
 *  · M-F1 Workbench 去掉 exhausted 分支（一律 StreamErrorCard）⇒「换横幅不给重试」红
 *  · M-F2 Composer 不传 disabled                              ⇒「输入框禁用」红
 *  · M-F3 横幅不渲染 balance                                   ⇒「说出余额」红
 *  · M-F4 横幅去掉两个入口之一                                 ⇒「两个入口」红
 *  · M-F5 横幅低调模式不换词（写死「公道值」）                  ⇒「低调用额度」红
 *  · M-F6 /account 上的两个锚点被删                            ⇒「入口不落空」红
 */
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CASE_WORDS, NEUTRAL_WORD } from '@/app/_ui/neutral';

/** 低调开关：每个用例渲染前拨一下 */
const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const { GongdaoExhaustedBanner } = await import('../StreamParts');

const render = (balance?: number, discreet = false) => {
  ui.discreet = discreet;
  const html = renderToStaticMarkup(<GongdaoExhaustedBanner balance={balance} />);
  ui.discreet = false;
  return html;
};

describe('横幅：说出余额、给出出路', () => {
  it('★说出余额这个数（裸「余额不足」四个字等于让人自己去查）', () => {
    expect(render(0)).toContain('>0<');
    expect(render(-5)).toContain('>-5<');
    // 服务端没给数就整句不报数字，而不是编一个 0——0 是一个真实且不同的余额
    const unknown = render(undefined);
    expect(unknown).not.toContain('余额是');
    expect(unknown).toContain('不够开始新的一轮');
  });

  it('★两个入口都在，且各自指向 /account 上真正的那一块', () => {
    const html = render(0);
    expect(html).toContain('href="/account#redeem"');
    expect(html).toContain('href="/account#recharge"');
  });

  it('★不给重试按钮：这一屏的出路不是重试', () => {
    expect(render(0)).not.toContain('重试');
  });

  it('说清为什么会用完（每轮按 token 扣），以及已开始的那一轮不受影响', () => {
    const html = render(0);
    expect(html).toContain('token');
    expect(html).toContain('已经开始的那一轮会照常答完');
  });
});

describe('横幅：低调模式', () => {
  it('★用中性词「额度」，一个「公道值」都不出现', () => {
    const html = render(0, true);
    expect(html).toContain(NEUTRAL_WORD.credits);
    expect(html).not.toContain('公道值');
  });

  it('★不含任何案情词（旁人扫一眼看不出这台手机在办什么事）', () => {
    const html = render(0, true);
    for (const word of CASE_WORDS) expect(html, word).not.toContain(word);
  });

  it('正对照：非低调时说的是产品原词', () => {
    expect(render(0, false)).toContain('公道值');
  });
});

/**
 * 入口不许落空：横幅上那两个 `#` 锚点，得在 /account 上真有对应的 id。
 * 没有它们，两个按钮把人丢在页顶——**而按钮本身看起来一切正常**，
 * 上面那条「两个入口都在」照样绿。
 */
describe('入口的另一半：/account 上的锚点', () => {
  const SRC = readFileSync(
    new URL('../../../../account/_components/AccountView.tsx', import.meta.url),
    'utf8',
  );

  it('★#redeem / #recharge 两个锚点都在页面上', () => {
    expect(SRC).toMatch(/id="redeem"/);
    expect(SRC).toMatch(/id="recharge"/);
  });
});
