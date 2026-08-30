/**
 * 面包屑在窄屏不许换行（C-08）。
 *
 * 顶栏是 `h-14` 固定 56px。360×740 下「驾驶舱 › 问它」的"问它"被挤到第二行，
 * 实测第二行 bottom=54.3px vs header 56px——净空 1.7px，看着像顶穿。
 * 根子是 shadcn 默认的 `flex-wrap`。
 *
 * **这里断的是类，不是像素**：node 环境没有排版引擎，量不了行高。
 * 所以每条断言都要说清它挡的是哪一步，别看成"证明了不换行"。
 * 真实布局回归靠截图那一路。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../breadcrumb';

const listClass = () => {
  const html = renderToStaticMarkup(
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>驾驶舱</BreadcrumbPage>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>问它</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
  );
  const raw = html.match(/data-slot="breadcrumb-list" class="([^"]*)"/)?.[1] ?? '';
  // 任意变体里的 & > * 在 HTML 属性里是转义过的，比回原样再断言
  return raw.replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<');
};

describe('BreadcrumbList 的窄屏收缩规则', () => {
  it('默认不换行，sm 往上才放回 flex-wrap', () => {
    const cls = listClass();
    expect(cls).toContain('flex-nowrap');
    expect(cls).toContain('sm:flex-wrap');
    // 光加 flex-nowrap 不删 flex-wrap 会两条并存，后写的赢——这条挡的是那种改法
    expect(cls).not.toMatch(/(^|\s)flex-wrap(\s|$)/);
  });

  /**
   * 中文没有单词边界，浏览器可以在任意两个汉字之间断开：
   * 不写死 whitespace-nowrap + shrink-0，空间不够时「驾驶舱」会被逐字压成三行，
   * 那比换行还难看。前几级是"回哪儿去"的路，一个字都不能少。
   */
  it('前几级不许被压窄、不许逐字折行', () => {
    const cls = listClass();
    expect(cls).toContain('[&>li]:shrink-0');
    expect(cls).toContain('[&>li]:whitespace-nowrap');
  });

  /** 挤压全落末项，且末项要能缩到 0（truncate 自带 overflow:hidden 才解得开 min-width:auto）。 */
  it('末项可缩 + 出省略号', () => {
    const cls = listClass();
    expect(cls).toContain('[&>li:last-child]:min-w-0');
    expect(cls).toContain('[&>li:last-child]:shrink');
    expect(cls).toContain('[&>li:last-child>*]:truncate');
  });

  it('调用方自己的 className 仍然拼得进来', () => {
    const html = renderToStaticMarkup(<BreadcrumbList className="text-ink" />);
    expect(html).toContain('text-ink');
    expect(html).toContain('flex-nowrap');
  });
});
