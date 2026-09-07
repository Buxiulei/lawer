// app/src/app/__tests__/terms-overseas.test.tsx
// 境外模型说明页与它的单独同意件（《个人信息保护法》第三十九条）。
//
// 【这一组拦的是什么】§39 要的是"逐项告知 + 单独同意"，两半都能单独坏，而且坏了都不报错：
//   · 告知少一项（比如没说个人信息的种类）——页面照常渲染，读起来还挺完整；
//   · 说明页与同意弹窗各写一份，慢慢分叉——用户点头时看的是弹窗那一份，
//     于是我们公示的告知与实际取得同意的告知不是同一段话；
//   · 「哪几类会被替换掉」写死成三个词，而 lib/llm/pii 的规则表变了——
//     页面上那句话仍然像一句承诺，只是它承诺的范围与实际不同；
//   · 「不同意」那个按钮没接线——用户按了它，什么也没发生，而他以为自己拒绝了。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 被按下的那几个按钮的 onClick，按渲染顺序。SSR 不会触发事件，所以在这里接住它们。 */
const clicks: (() => void)[] = [];

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/shadcn/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => {
    if (onClick) clicks.push(onClick);
    return <button disabled={disabled}>{children}</button>;
  },
}));

const { default: OverseasPage } = await import('@/app/terms/overseas/page');
const { OverseasConsent } = await import('@/app/terms/overseas/OverseasConsent');
const { NOT_REDACTED, OVERSEAS_RECIPIENT, REDACTED_KINDS } = await import(
  '@/app/terms/overseas/OverseasDetails'
);
const { TERMS_QUOTES } = await import('@/app/terms/quotes');
const { PII_PATTERNS } = await import('@/lib/llm/pii');
const { TERMS_HREF, TERMS_PROCESSORS_HREF } = await import('@/app/_ui/termsLinks');

const pageHtml = renderToStaticMarkup(<OverseasPage />);
const pageText = pageHtml.replace(/<[^>]+>/g, '');

describe('境外模型说明页：§39 要求告知的每一项', () => {
  const ITEMS = ['境外接收方', '联系方式', '处理目的', '处理方式', '个人信息种类', '行使权利的方式'];

  /**
   * 页面上真正渲染出来的项目名（<dt> 一栏一个）。
   *
   * 【为什么按 <dt> 取，而不是在整页正文里 includes】includes 是**子串**匹配：
   * 把「行使权利的方式」这一项的标签改成「行使权利的方式（暂缺）」、
   * 或者干脆把这几个字挪进某一段散文里，includes 照样命中，而 §39 要求的
   *「逐项告知」已经不成立了。按 <dt> 取则是"这一项作为一项存在"。
   */
  const dts = [...pageHtml.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim(),
  );

  for (const label of ITEMS) {
    it(`「${label}」这一项在（变异：删掉这一行 → 红）`, () => {
      expect(dts, `§39 要求告知的「${label}」没有作为独立一项写出来。页面上现有的项：${dts.join(' / ')}`).toContain(
        label,
      );
    });
  }

  it('接收方写的是它的名字，并说清了是经中转接入', () => {
    expect(pageText).toContain(OVERSEAS_RECIPIENT);
    expect(pageText, '没说清请求先经中转再出境').toContain('经中转服务商接入');
  });

  it('§39 原文逐字印在页上（变异：只写条号不印原文 → 红）', () => {
    expect(pageText).toContain(TERMS_QUOTES.gebaofa39.text);
    expect(pageText).toContain('《个人信息保护法》第三十九条');
  });

  it('默认关闭、不同意也能用全部境内服务，两句都在', () => {
    expect(pageText).toContain('境外模型默认关闭');
    expect(pageText).toContain('仅境内模型的全部服务');
  });

  it('指得回协议与受托方清单', () => {
    expect(pageHtml).toContain(`href="${TERMS_HREF}"`);
    expect(pageHtml).toContain(`href="${TERMS_PROCESSORS_HREF}"`);
  });
});

describe('境外模型说明页：脱敏范围与真正的规则表同源', () => {
  /**
   * 【变异臂】给 lib/llm/pii 的 PII_PATTERNS 加一类（或去掉一类），
   * 而页面上那句话写死三个词 ⇒ 这条红。
   * 这是这一组里唯一一条能拦住"假承诺"的判据：页面说会替换掉某一类而实际不会，
   * 用户会据此决定开不开境外模型。
   */
  it('页面列出的类别 = PII_PATTERNS 里真正会被替换的那几类', () => {
    const kinds = [...new Set(PII_PATTERNS.map((p) => p.kind))];
    expect(REDACTED_KINDS).toEqual(kinds);
    for (const k of kinds) {
      expect(pageText, `规则表里会替换「${k}」，页面上却没说`).toContain(k);
    }
  });

  it('页面明写了姓名、公司名称、事实经过**不**替换（变异：删掉这一句 → 红）', () => {
    /*
     * 【为什么不是逐个词 includes 就算数】「姓名」「公司名称」「事实经过」这几个词
     * 在这一页上到处都是（「个人信息种类」那一项就把它们逐个列了一遍）。
     * 逐个 includes 的形态是：把「…不作替换」整句删掉、换成一句
     *「均按规则处理」，这条判据仍然全绿——而页面从此不再告诉用户
     * **他写下的经过会原样出境**，那恰恰是决定开不开的唯一一句。
     * 所以钉的是这几个词与「不作替换」**绑在同一句话里**。
     */
    expect(
      pageText,
      `没把"${NOT_REDACTED.join('、')}不作替换"这句话完整说出来——` +
        '拆开写的形态是：这几个词在页上，而"它们不会被替换"这个意思不在。',
    ).toContain(`${NOT_REDACTED.join('、')}不作替换`);
    expect(pageText, '没把"经过会原样出境"这句话说出来').toContain('会原样出境');
  });

  it('第三十八条那条路与单独同意分得清楚，且开放时点仍是待确认', () => {
    expect(pageText).toContain('第三十八条');
    expect(pageText, '把"取得同意"说成"已经可以出境"是最危险的一种混淆').toContain(
      '谁也替代不了谁',
    );
    expect(pageHtml, '开放时点被人填上了？那要主理人裁定，不是这一页说了算').toContain(
      'data-pending="1"',
    );
  });
});

describe('OverseasConsent：告知与取意是同一段话，两个按钮都接了线', () => {
  beforeEach(() => {
    clicks.length = 0;
  });

  it('同意件里的告知与说明页是同一份（变异：在同意件里另写一段告知 → 红）', () => {
    const consent = renderToStaticMarkup(
      <OverseasConsent onAgree={() => {}} onDecline={() => {}} />,
    ).replace(/<[^>]+>/g, '');
    // 逐项标签与说明页完全一致：它们渲染的是同一个 <OverseasDetails/>
    for (const label of ['境外接收方', '处理目的', '个人信息种类', '行使权利的方式']) {
      expect(consent).toContain(label);
    }
    expect(consent).toContain(OVERSEAS_RECIPIENT);
    for (const k of REDACTED_KINDS) expect(consent).toContain(k);
  });

  it('两个按钮：同意与不同意都在，且都写明了后果', () => {
    const consent = renderToStaticMarkup(
      <OverseasConsent onAgree={() => {}} onDecline={() => {}} />,
    ).replace(/<[^>]+>/g, '');
    expect(consent).toContain('我已读并同意，开启境外模型');
    expect(consent, '「不同意」不能只是一个叉号：那样系统只知道"没同意"，说不清他表示过什么').toContain(
      '不同意，继续只用境内模型',
    );
    expect(consent).toContain('单独同意');
  });

  it('「同意」按的是 onAgree（变异：把两个按钮接到同一个回调 → 红）', async () => {
    const agree = vi.fn();
    const decline = vi.fn();
    renderToStaticMarkup(<OverseasConsent onAgree={agree} onDecline={decline} />);
    expect(clicks.length, '没接住两个按钮的 onClick，量具坏了').toBe(2);
    await clicks[0]();
    expect(agree).toHaveBeenCalledTimes(1);
    expect(decline).not.toHaveBeenCalled();
  });

  it('「不同意」按的是 onDecline', async () => {
    const agree = vi.fn();
    const decline = vi.fn();
    renderToStaticMarkup(<OverseasConsent onAgree={agree} onDecline={decline} />);
    await clicks[1]();
    expect(decline).toHaveBeenCalledTimes(1);
    expect(agree).not.toHaveBeenCalled();
  });
});
