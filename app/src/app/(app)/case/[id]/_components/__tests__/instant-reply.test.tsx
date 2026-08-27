import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstantReplyCard } from '../StreamParts';

/** buildCrisisOpener 的真实输出形状（窗外首次态）。文本层不许改，这里照抄。 */
const OPENER = [
  '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。',
  '先把号码给你——不用等我说完后面的话，任何时候都能打：',
  '',
  '- **12356** 全国统一心理援助热线（24小时）',
  '- **010-82951332** 北京心理援助热线（24小时）',
  '  ——**仅座机可拨**；用手机请拨下面那条',
  '- **800-810-1117** 北京心理援助热线（手机可拨）',
  '',
  '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。',
].join('\n');

describe('危机轮首段', () => {
  it('三个号码各渲染成一个 tel: 链接，连字符在 href 里去掉', () => {
    const html = renderToStaticMarkup(<InstantReplyCard text={OPENER} />);
    expect(html).toContain('href="tel:12356"');
    expect(html).toContain('href="tel:01082951332"');
    expect(html).toContain('href="tel:8008101117"');
  });

  it('座机附注挂在它自己那条号码上，不跑到下一条去', () => {
    const html = renderToStaticMarkup(<InstantReplyCard text={OPENER} />);
    const i1 = html.indexOf('tel:01082951332');
    const iCaveat = html.indexOf('仅座机可拨');
    const i2 = html.indexOf('tel:8008101117');
    expect(i1).toBeLessThan(iCaveat);
    expect(iCaveat).toBeLessThan(i2);
  });

  /**
   * **这条是 spec D17 的守卫，别删。**
   * 低调模式立的是不知情者标准，但危机轮那一刻优先级是接通不是隐藏——
   * 热线块是全站唯一豁免打码的正文（产品负责人 2026-08-27 拍板）。
   * 另有实现上的理由：号码是 tel: 链接，而糊层「按住 150ms 才揭开」且揭开会吞掉那次 click，
   * **短按会拨出一个用户根本没看见的号码**。打码与可拨号在这里不能共存。
   */
  it('整块不带 data-veil——低调模式下热线必须清晰可读', () => {
    const html = renderToStaticMarkup(<InstantReplyCard text={OPENER} />);
    expect(html).not.toContain('data-veil');
  });

  it('非号码行原样成段，文本一个字不改', () => {
    const html = renderToStaticMarkup(<InstantReplyCard text={OPENER} />);
    expect(html).toContain('你刚才说的话我听见了');
    expect(html).toContain('电话那头是受过训练的人');
  });

  it('复现态只有一行号码时也拆成两个按钮', () => {
    const compact = ['先把号码给你：', '', '**12356 / 010-82951332（座机）**'].join('\n');
    const html = renderToStaticMarkup(<InstantReplyCard text={compact} />);
    expect(html).toContain('href="tel:12356"');
    expect(html).toContain('href="tel:01082951332"');
  });
});
