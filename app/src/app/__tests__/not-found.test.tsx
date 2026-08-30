/**
 * 全站 404（D-07）。
 *
 * 在补这个文件之前，任何 `notFound()` 都落到 Next.js 自带的那张页：
 * 黑色衬线体的「404 │ This page could not be found.」，一句中文没有、一个按钮没有，
 * 而壳层（顶栏、演示横幅、底部 Tab）照常渲染——**看起来是站内页，内容却是框架的**。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const pathname = { value: '/case/demo/drafts/dr_does_not_exist' };
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: NotFound } = await import('../not-found');

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('404 卡', () => {
  it('三段都在：出了什么事 / 为什么 / 现在能做什么', () => {
    const html = renderToStaticMarkup(<NotFound />);
    const plain = text(html);
    expect(plain).toContain('这个地址上没有内容');
    expect(plain).toMatch(/编号|过期|删/);
    expect(plain).toContain('回驾驶舱');
  });

  it('一个英文字都不留——框架那张页只有英文，换掉就得换干净', () => {
    expect(text(renderToStaticMarkup(<NotFound />))).not.toMatch(/[A-Za-z]/);
  });

  it('「回驾驶舱」落到当前地址所属的那个案件，不是写死的某一个', () => {
    pathname.value = '/case/c_7788/evidence/ev_gone';
    expect(renderToStaticMarkup(<NotFound />)).toContain('href="/case/c_7788"');
    pathname.value = '/case/demo/drafts/dr_does_not_exist';
    expect(renderToStaticMarkup(<NotFound />)).toContain('href="/case/demo"');
  });

  /**
   * 低调模式下这张卡不进糊层：整段没有案件名、公司名和金额可泄，
   * 而它是用户当下唯一的解释——糊掉就等于回到"页面坏了但不说为什么"。
   */
  it('不带 data-veil', () => {
    expect(renderToStaticMarkup(<NotFound />)).not.toContain('data-veil');
  });
});
