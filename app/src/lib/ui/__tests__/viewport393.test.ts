// app/src/lib/ui/__tests__/viewport393.test.ts
// **量尺自己的体检**。先审量具再信读数：一把抓不到东西的尺子，读出来的绿和
// "这一屏真的不横滚" 长得一模一样，而后者才是我们想要的结论。
//
// 所以这一组的重点不是"某个组件通过了"，而是"这把尺子在该报警时真的报警"：
// 造一个 520px 的盒子必须被抓到、放进滚动容器必须放行、384px（w-96）不许误报。
import { describe, expect, it } from 'vitest';

import { MOBILE_VIEWPORT, describeWideElements, findWideElements } from '../viewport393';

describe('393 量尺：抓得到写死的过宽盒子', () => {
  it('class 任意值 w-[520px] 被抓到，并点名说是哪一条声明', () => {
    const found = findWideElements('<div class="rounded p-2 w-[520px]">x</div>');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tag: 'div', declaration: 'w-[520px]', px: 520 });
    expect(describeWideElements(found)).toContain('w-[520px]');
  });

  it('min-w-[26rem]（416px）被抓到；rem 要换算，不能只认 px', () => {
    const found = findWideElements('<section class="min-w-[26rem]"></section>');
    expect(found).toHaveLength(1);
    expect(found[0].px).toBe(416);
  });

  it('Tailwind 数值档 w-104（416px）被抓到，w-96（384px）不误报', () => {
    expect(findWideElements('<div class="w-104"></div>')).toHaveLength(1);
    expect(findWideElements('<div class="w-96"></div>')).toHaveLength(0);
  });

  it('内联 style 的 width / min-width 一样算数（class 不是唯一的写宽方式）', () => {
    expect(findWideElements('<div style="min-width:480px"></div>')).toHaveLength(1);
    expect(findWideElements('<div style="width: 30rem; color:red"></div>')).toHaveLength(1);
    expect(findWideElements('<div style="max-width:900px"></div>')).toHaveLength(0);
  });

  it('恰好等于视口宽不报（393 不算溢出，394 才算）', () => {
    expect(findWideElements(`<div class="w-[${MOBILE_VIEWPORT}px]"></div>`)).toHaveLength(0);
    expect(findWideElements(`<div class="w-[${MOBILE_VIEWPORT + 1}px]"></div>`)).toHaveLength(1);
  });
});

describe('393 量尺：该放行的放行', () => {
  it('在 overflow-x-auto 容器里的宽内容放行（宽表格该在自己的容器里横滚）', () => {
    const html =
      '<div class="overflow-x-auto"><table class="min-w-[640px]"><tr><td>x</td></tr></table></div>';
    expect(findWideElements(html)).toHaveLength(0);
  });

  it('滚动容器闭合之后不再放行（放行范围只到它自己的子树）', () => {
    const html =
      '<div class="overflow-x-auto"><div class="w-[640px]"></div></div><div class="w-[640px]"></div>';
    const found = findWideElements(html);
    expect(found).toHaveLength(1);
  });

  it('max-w-[900px] 是上限不是下限，不撑宽，不报', () => {
    expect(findWideElements('<div class="max-w-[900px]"></div>')).toHaveLength(0);
  });

  it('sm: 及以上断点的宽度在 393 上不生效，不报；max-sm: 在 393 上生效，照报', () => {
    expect(findWideElements('<div class="sm:w-[640px] lg:min-w-[900px]"></div>')).toHaveLength(0);
    expect(findWideElements('<div class="max-sm:w-[640px]"></div>')).toHaveLength(1);
  });
});
