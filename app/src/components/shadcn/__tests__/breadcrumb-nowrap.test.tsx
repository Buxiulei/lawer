/**
 * 面包屑在窄屏不许换行（C-08）。
 *
 * 顶栏是 `h-14` 固定 56px。360×740 下「驾驶舱 › 问它」的"问它"被挤到第二行，
 * 实测第二行 bottom=54.3px vs header 56px——净空 1.7px，看着像顶穿。
 * 根子是 shadcn 默认的 `flex-wrap`。
 *
 * **判据不在这个文件里。** node 环境没有排版引擎，clientWidth/scrollWidth 恒为 0，
 * 断类串证明不了收缩链通没通——上一版就是这么放过去的：
 * 类全在（truncate/min-w-0/shrink 一个不少），最外层 <nav> 却是 min-width:auto，
 * 顶死在内容宽上，下游一次都没触发，360 上实测压住「案件档案」按钮 12px，而这些断言全绿。
 *
 * C-08 的判据是 `scripts/perf/g5-breadcrumb.mjs`：真浏览器 360×740 量
 * 末项 clientWidth < scrollWidth（省略号是真的）。**这里只做一件事**——
 * 挡住"收缩链上某一环被人删掉"，让改动在跑浏览器判据之前就先红一次。
 * 每条断言下面写清它挡的是哪一环。
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

const unescape = (s: string) =>
  s.replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<');

const markup = () =>
  renderToStaticMarkup(
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

/** 任意变体里的 `&>*` 在 HTML 属性里是转义过的，比回原样再断言 */
const classOf = (slot: string) =>
  unescape(markup().match(new RegExp(`data-slot="${slot}" class="([^"]*)"`))?.[1] ?? '');

const listClass = () => classOf('breadcrumb-list');

/**
 * 收缩链的**第一环**：顶栏拿 <nav> 当 flex item，flex item 的 min-width 默认解成 auto。
 * 这一环缺了，下面 BreadcrumbList 里的 shrink/truncate 全部作废——
 * 而且是"类都在、效果一个没有"的那种作废，只看类串看不出来。
 * 删掉 nav 的 min-w-0，这条转红，g5-breadcrumb.mjs 也跟着转红。
 */
describe('Breadcrumb 外层 nav', () => {
  it('nav 自己要能缩：min-w-0', () => {
    expect(classOf('breadcrumb')).toContain('min-w-0');
  });

  it('调用方的 className 拼得进来，且不吃掉 min-w-0', () => {
    const html = renderToStaticMarkup(<Breadcrumb className="grow" />);
    expect(html).toContain('grow');
    expect(html).toContain('min-w-0');
  });
});

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
