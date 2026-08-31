/**
 * 低调模式下的标签页图标。
 *
 * 这一处是 PC 独有的泄密面：`document.title` 早就中性化了，favicon 却既不在
 * 页面里、也不由 React 渲染——08-28「持久标记用头部紧裁」管页面内，
 * `Mascot` 返回 null 管组件，两条纪律都没盖到它。
 *
 * 真实行为（head 里到底剩几个 link）由 scripts/perf/ws-grid.mjs ⑥ 在真浏览器里量。
 * 本文件只钉两件在源码层面就能定死的事：中性图标不含任何品牌痕迹，
 * 以及**首屏脚本与运行时模块用的是同一套属性名**——这两条路一旦漂移，
 * 首屏停用的节点运行时就还原不回来，而且不会报错。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_ICON_HREF, faviconBootstrapSnippet } from '../favicon';
import { discreetBootstrapScript } from '../bootstrap';

describe('中性图标', () => {
  it('是自带的 data URI，不回源站取图', () => {
    expect(NEUTRAL_ICON_HREF.startsWith('data:image/svg+xml,')).toBe(true);
    // 图标本身不许再引任何外部资源。SVG 的 xmlns 是命名空间不是请求，剔掉再看。
    const 去掉命名空间 = NEUTRAL_ICON_HREF.replace(/xmlns='[^']*'/g, '');
    expect(去掉命名空间).not.toMatch(/https?:|url\(|xlink|<image/i);
  });

  it('不含任何品牌或案由痕迹', () => {
    for (const word of ['tubashu', '土八鼠', 'mascot', 'icon-32', 'icon-192', '仲裁', '裁员']) {
      expect(NEUTRAL_ICON_HREF.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('# 号已转义——没转义的话整条 URI 从颜色值处被截断，图标直接不显示', () => {
    expect(NEUTRAL_ICON_HREF).not.toContain('#');
    expect(NEUTRAL_ICON_HREF).toContain('%23');
  });
});

describe('首屏脚本与运行时模块不许漂移', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/_ui/favicon.ts'), 'utf8');

  it('首屏那段用的属性名与模块里的是同一批', () => {
    for (const attr of ['data-neutral-icon', 'data-icon-rel', 'x-parked-icon']) {
      expect(faviconBootstrapSnippet).toContain(attr);
      expect(src).toContain(attr);
    }
  });

  it('首屏脚本真的被拼进了低调模式的启动脚本里', () => {
    expect(discreetBootstrapScript).toContain('data-neutral-icon');
    expect(discreetBootstrapScript).toContain(NEUTRAL_ICON_HREF);
  });

  it('首屏那段是可以直接进 <script> 的一行 JS，不带换行也不提前收尾', () => {
    expect(faviconBootstrapSnippet).not.toContain('\n');
    expect(faviconBootstrapSnippet).not.toContain('</script');
  });
});
