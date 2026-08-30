// scripts/perf/g5-breadcrumb.mjs
// C-08 的判据：窄屏顶栏里，面包屑末项到底有没有真出省略号。
//
// 【为什么不能在 vitest 里断】node 环境没有排版引擎，clientWidth/scrollWidth 恒为 0。
// 上一版把判据写成"类串里有 truncate / min-w-0"，结果是**类都在、效果一个都没有**：
// 收缩链上任何一环忘了 min-width:0（当时忘的是最外层 <nav>），
// 下游的 truncate 就永远不触发，而类串断言照旧全绿。
// 断类串证明不了收缩，只有真浏览器量得出来。
//
// 判据（PASS 需要全部满足）：
//   1. 末项那个文本元素 clientWidth < scrollWidth —— 被夹住了、省略号是真的
//   2. 前几级（驾驶舱 / 分隔符）一个像素都没被压：宽度 == 它们的 scrollWidth
//   3. 面包屑没有折到第二行：nav 高度 < 顶栏 h-14 的一半 + 行高冗余
// 另外原样打两个数（**都不计入 PASS**，归台账 C-08b）：
//   · nav 右边缘 − 案件档案按钮左边缘（正数 = 还在压住按钮）
//   · 末项可视宽 —— 收缩链通了之后它剩多少，取决于右侧控件占多宽
//
// 跑法：
//   cd app && npx next dev -p 3129 &
//   PERF_BASE=http://localhost:3129 node scripts/perf/g5-breadcrumb.mjs
// 退出码 0 = PASS，1 = FAIL。
//
// 【别用 127.0.0.1 当 PERF_BASE】Next dev 的 allowedDevOrigins 默认只放行 localhost，
// 从 127.0.0.1 进来的 /_next 客户端 chunk 会被拦掉 ⇒ 页面**只有服务端 HTML、不 hydrate**
// ⇒「案件档案」按钮压根不登记 ⇒ 右侧窄一大截 ⇒ 面包屑挤不着 ⇒ 判据假绿。
// 实测过：同一份代码，127.0.0.1 量出重叠 108px（其实是按钮不存在），localhost 量出 12px。
// 本脚本等不到那个按钮就直接报错，不会静默量一个不犯病的版式。
import { launchIsolated, BASE, shutdown } from './lib.mjs';

/** 复现宽度：360×740。393 那档本来就不犯病，要用最窄的常见机型。 */
const WIDTH = Number(process.env.PERF_WIDTH || 360);
const PATH = process.env.PERF_PATH || '/case/demo/ask';

const { browser, proc } = await launchIsolated();
let ok = false;
try {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: 740 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + PATH, { waitUntil: 'load', timeout: 90000 });
  await page.waitForSelector('nav[aria-label="面包屑"] ol', { timeout: 30000 });
  // 「案件档案」按钮由页面 hydrate 之后登记（casePanel.tsx），**必须等到它**：
  // 少了它右侧控件窄一大截，面包屑根本挤不着，量出来的是一个不犯病的版式。
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('header button')].some((b) => b.textContent.includes('案件档案')),
      null,
      { timeout: 30000 },
    )
    .catch(() => {
      throw new Error(
        `顶栏一直没出现「案件档案」按钮（${PATH}）。\n` +
          `  为什么要等它：它是右侧控件里最宽的一个，没有它面包屑不会被挤，判据会假绿。\n` +
          `  怎么办：确认 PERF_PATH 指的是工作台路由（默认 /case/demo/ask，Workbench 只对 demo 案件登记），` +
          `且 ${BASE} 上跑的是本 worktree 的代码。`,
      );
    });

  const r = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="面包屑"]');
    const ol = nav.querySelector('ol');
    const lis = [...ol.children];
    const last = lis[lis.length - 1];
    // 末项的文本元素：truncate 挂在 li 的直接子元素上（BreadcrumbPage / BreadcrumbLink）
    const text = last.firstElementChild ?? last;
    const header = nav.closest('header');
    const archive = [...header.querySelectorAll('button')].find((b) =>
      b.textContent.includes('案件档案'),
    );
    const box = (e) => (e ? e.getBoundingClientRect() : null);
    return {
      navMinWidth: getComputedStyle(nav).minWidth,
      navRect: box(nav),
      navHeight: nav.getBoundingClientRect().height,
      olClient: ol.clientWidth,
      olScroll: ol.scrollWidth,
      lastText: text.textContent,
      lastClient: text.clientWidth,
      lastScroll: text.scrollWidth,
      lastTextOverflow: getComputedStyle(text).textOverflow,
      // 前几级不许被压：逐个比自己的可视宽和内容宽
      head: lis.slice(0, -1).map((li) => {
        const el = li.firstElementChild ?? li;
        return { text: li.textContent.trim(), client: el.clientWidth, scroll: el.scrollWidth };
      }),
      headerHeight: header.getBoundingClientRect().height,
      archiveLeft: archive ? box(archive).left : null,
      navRight: box(nav).right,
    };
  });

  const 末项被夹住 = r.lastClient < r.lastScroll;
  const 前几级完好 = r.head.every((h) => h.client >= h.scroll);
  const 没折行 = r.navHeight < 34; // 单行 14px 文本约 20px；折两行会超过 34
  const 压住多少 = +(r.navRight - r.archiveLeft).toFixed(2);

  console.log(`视口 ${WIDTH}×740  路由 ${PATH}`);
  console.log(`  nav min-width        : ${r.navMinWidth}`);
  console.log(`  nav 高度 / 顶栏高度  : ${r.navHeight.toFixed(2)} / ${r.headerHeight.toFixed(2)}`);
  console.log(`  ol  client / scroll  : ${r.olClient} / ${r.olScroll}`);
  console.log(
    `  末项「${r.lastText}」client / scroll : ${r.lastClient} / ${r.lastScroll}` +
      `  text-overflow=${r.lastTextOverflow}`,
  );
  for (const h of r.head) {
    console.log(`  前级「${h.text}」client / scroll : ${h.client} / ${h.scroll}`);
  }
  console.log(
    `  C-08b（不计入判据）: nav 右边缘 − 案件档案左边缘 = ${压住多少}px；` +
      `末项可视宽 ${r.lastClient}px`,
  );
  console.log('');
  console.log(`  [1] 末项 clientWidth < scrollWidth（真出省略号）: ${末项被夹住 ? 'PASS' : 'FAIL'}`);
  console.log(`  [2] 前几级一个像素没被压                        : ${前几级完好 ? 'PASS' : 'FAIL'}`);
  console.log(`  [3] 面包屑没折到第二行                          : ${没折行 ? 'PASS' : 'FAIL'}`);

  ok = 末项被夹住 && 前几级完好 && 没折行;
  console.log(`\nC-08 判据：${ok ? 'PASS' : 'FAIL'}`);
  await ctx.close();
} finally {
  await shutdown({ browser, proc });
}
process.exit(ok ? 0 : 1);
