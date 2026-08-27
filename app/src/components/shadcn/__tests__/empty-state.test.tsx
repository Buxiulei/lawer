import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../empty-state';

/**
 * 这条测试挡的是一个**已经发生过**的漏洞（B2 #53）：
 * 手写版 ui/EmptyState 的 description 带 `data-veil`，迁到 shadcn 版时掉了，
 * 而文件头注释还写着「props 与手写版逐字一致」——props 确实一致，少的是一个属性。
 * **类型对、props 对、tsc 全绿，唯独低调模式下这段文字不糊。**
 * 没有任何信号会提示这件事，只有断言能挡。
 */
describe('EmptyState 的 description 必须进低调模式糊层', () => {
  it('渲染出的 description 段带 data-veil', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="还没有解读过的文件" description="把解除通知拍下来传上去。" />,
    );
    // 不只查"页面里有 data-veil"，要查**承载这段正文的那个元素**带着它——
    // 否则属性挂在别处也能让断言变绿。
    const seg = html.slice(html.indexOf('把解除通知'));
    const openTag = html.slice(0, html.indexOf('把解除通知')).lastIndexOf('<p');
    expect(html.slice(openTag, html.indexOf('把解除通知'))).toContain('data-veil');
    expect(seg.length).toBeGreaterThan(0);
  });

  it('没有 description 时不渲染空的糊层块', () => {
    const html = renderToStaticMarkup(<EmptyState title="标题" />);
    expect(html).not.toContain('data-veil');
  });

  // title 不打码是有意的：低调模式的中性化由词表（_ui/neutral.ts）在文案层面完成，
  // 标题本身要保持可读，否则整页只剩糊块，人会以为页面坏了。
  it('title 不带 data-veil', () => {
    const html = renderToStaticMarkup(<EmptyState title="资料还是空的" />);
    expect(html).toContain('资料还是空的');
    expect(html).not.toContain('data-veil');
  });
});
