/**
 * 后台切换条的守卫。
 *
 * 【立这组的由头】/woo/users 与 /woo/codes 之间此前一个链接都没有，站在账号管理台上
 * 想去兑换码只能手敲地址——主理人 2026-09-04 就是这么发现的。这一条修的是这个。
 *
 * 钉三件事：
 *   ① 两个页签的 href 就是那两条真地址（打错一个字母，页面照样渲染、按下去是 404）；
 *   ② 当前页高亮，且**只高亮一个**——两个都亮或都不亮，等于没有位置指示；
 *   ③ 渲染出来的页签与 WOO_TABS 逐条一致：新增后台页时只准改那一份常量。
 *
 * 【量具边界】node 环境没有 DOM，量的是静态 HTML 上的 href 与 aria-current，
 * 不是"点下去真的跳过去了"。next/link 与 usePathname 都被顶掉：
 * 前者在这里就是个 <a>，后者是这一组唯一要拨的旋钮。
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let pathname = '/woo/users';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
// 属性整包透传：只挑 href 转发的话，aria-current 那两条断言永远读不到东西，
// 会红得像"高亮坏了"，其实是量具漏了一格。
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { WooNav, WOO_TABS } = await import('../WooNav');

interface Anchor {
  href: string;
  text: string;
  current: boolean;
}

function anchors(at: string): Anchor[] {
  pathname = at;
  const html = renderToStaticMarkup(<WooNav />);
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1] ?? '',
    text: m[2].replace(/<[^>]+>/g, '').trim(),
    current: m[1].includes('aria-current="page"'),
  }));
}

describe('后台切换条', () => {
  it('两个页签，href 与文案就是 WOO_TABS 那一份', () => {
    const list = anchors('/woo/users');
    expect(list.map((a) => a.href)).toEqual(['/woo/users', '/woo/codes']);
    expect(list.map((a) => a.text)).toEqual(['账号', '兑换码']);
    // 常量是唯一真源：谁在组件里手写第三个页签而不改常量，这条红。
    expect(list.map((a) => ({ href: a.href, label: a.text }))).toEqual(
      WOO_TABS.map((t) => ({ href: t.href, label: t.label })),
    );
  });

  it('在 /woo/users 上只高亮「账号」', () => {
    const list = anchors('/woo/users');
    expect(list.filter((a) => a.current).map((a) => a.href)).toEqual(['/woo/users']);
  });

  it('在 /woo/codes 上只高亮「兑换码」', () => {
    const list = anchors('/woo/codes');
    expect(list.filter((a) => a.current).map((a) => a.href)).toEqual(['/woo/codes']);
  });

  it('对照臂：不在这两页上时一个都不亮（证明高亮不是写死的）', () => {
    expect(anchors('/case/1').filter((a) => a.current)).toHaveLength(0);
  });
});
