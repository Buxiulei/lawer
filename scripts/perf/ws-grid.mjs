// scripts/perf/ws-grid.mjs — 桌面工作台「布局分发层」的验收探针（批6-A）。
//
// 这些判据都是**运行时**才成立的，源码里看不出来：容器查询的结果、⌘B 之后
// 栏数变没变、流还在不在。所以它们必须在真浏览器里量，而不是靠 vitest 断言标记。
//
// 每条判据都带一条**变异臂**：先证明这条断言在故意做错时会红。
// 没有变异臂的绿灯说明不了任何事——「守着零个东西」和「真没问题」在外部同形。
//
//   PERF_BASE=http://127.0.0.1:3271 node scripts/perf/ws-grid.mjs
import { launchIsolated, shutdown, sleep, seedDiscreet, BASE } from './lib.mjs';

const ASK = '/case/demo/ask';
let fails = 0;
const ok = (cond, name, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`);
  return cond;
};

/** 轨道字符串 → 非零轨道数（栏数）。 */
const colsOf = (tpl) => tpl.split(/\s+/).filter((t) => parseFloat(t) > 0).length;

async function open(browser, width, height = 900, init) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: width < 700,
    hasTouch: width < 700,
  });
  if (init) await init(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE + ASK, { waitUntil: 'networkidle' });
  await sleep(1200);
  return { ctx, page };
}

const { browser, proc } = await launchIsolated();
try {
  // ── ① 单实例守卫 ────────────────────────────────────────────
  console.log('\n① 单实例：全站只许有一个工作区（防「两棵树都渲染、CSS 藏一棵」）');
  for (const w of [393, 768, 1280, 1536, 1680]) {
    const { ctx, page } = await open(browser, w);
    const n = await page.evaluate(() => document.querySelectorAll('[data-workspace]').length);
    ok(n === 1, `${w}px 实例数 = 1`, `实测 ${n}`);
    if (w === 1536) {
      // 变异臂：手工塞第二棵，断言必须翻红
      const n2 = await page.evaluate(() => {
        const d = document.createElement('div');
        d.setAttribute('data-workspace', '');
        d.style.display = 'none'; // 正是「CSS 藏一棵」那种藏法
        document.body.appendChild(d);
        return document.querySelectorAll('[data-workspace]').length;
      });
      ok(n2 === 2, '变异臂：塞进第二棵后计数变 2（说明这条断言真在数）', `实测 ${n2}`);
    }
    await ctx.close();
  }

  // ── ② 容器查询对照臂 ────────────────────────────────────────
  // 同一个视口，只按 ⌘B 改侧栏宽度 → 栏数变。媒体查询做不出这一对。
  console.log('\n② 容器查询对照臂：1536 视口，⌘B 前后栏数不同');
  {
    const { ctx, page } = await open(browser, 1536, 950);
    const read = () =>
      page.evaluate(() => {
        const g = document.querySelector('.ws-grid');
        const ws = document.querySelector('[data-workspace]');
        return {
          容器: +ws.getBoundingClientRect().width.toFixed(0),
          轨道: getComputedStyle(g).gridTemplateColumns,
        };
      });
    // 查看器的内容归 B 路；这一层的输入只有两个 data-*，探针直接给输入
    await page.evaluate(() => document.querySelector('.ws-grid').setAttribute('data-viewer', '1'));
    const before = await read();
    ok(colsOf(before.轨道) === 2, '侧栏展开 → 双栏', `容器 ${before.容器}px  轨道 ${before.轨道}`);

    await page.keyboard.press('Control+b');
    await sleep(500);
    await page.evaluate(() => document.querySelector('.ws-grid').setAttribute('data-viewer', '1'));
    await sleep(100);
    const after = await read();
    ok(colsOf(after.轨道) === 3, '侧栏收起 → 三栏（⌘B = 腾出第三栏）', `容器 ${after.容器}px  轨道 ${after.轨道}`);
    ok(
      after.容器 > before.容器 && Math.abs(after.容器 - before.容器 - 184) < 4,
      '容器宽差 = 侧栏展开与收起之差（240−56=184）',
      `${before.容器} → ${after.容器}`,
    );
    await ctx.close();
  }
  {
    // 变异臂：同样把 data-viewer 打开，但视口不够宽 → 必须仍是双栏。
    // 这一条防的是「把三栏写成无条件显示」——那样上面那条也会绿。
    const { ctx, page } = await open(browser, 1280);
    const tpl = await page.evaluate(() => {
      const g = document.querySelector('.ws-grid');
      g.setAttribute('data-viewer', '1');
      return getComputedStyle(g).gridTemplateColumns;
    });
    ok(colsOf(tpl) === 2, '变异臂：1280 下开查看器仍是双栏（阈值真在起作用）', tpl);
    await ctx.close();
  }

  // ── ③ 不卸载证明 ───────────────────────────────────────────
  console.log('\n③ 不卸载：流式中按 ⌘B 重排，chunk 继续长、焦点不丢、树没重建');
  {
    const { ctx, page } = await open(browser, 1536, 950);
    await page.evaluate(() => {
      // 给工作区盖个戳；重建过就没了
      document.querySelector('[data-workspace]').dataset.probeStamp = 'x';
    });
    await page.fill('textarea[aria-label="输入消息"]', '按 ⌘B 之后这条流还在吗');
    await page.keyboard.press('Control+Enter');
    // 等流真的开始吐字
    await page.waitForFunction(
      () => (document.querySelector('.ws-main')?.innerText.length ?? 0) > 0 &&
        !!document.querySelector('[data-slot="button"][aria-label="停止输出"], button[aria-label="停止输出"]'),
      null,
      { timeout: 20000 },
    ).catch(() => {});
    await page.waitForFunction(
      () => (window.__len = document.querySelector('.ws-main').innerText.length) > 0,
      null,
      { timeout: 20000 },
    );
    const t0 = await page.evaluate(() => document.querySelector('.ws-main').innerText.length);
    const focus0 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

    await page.keyboard.press('Control+b');
    await sleep(1500);

    const t1 = await page.evaluate(() => document.querySelector('.ws-main').innerText.length);
    const focus1 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
    const stamp = await page.evaluate(() => document.querySelector('[data-workspace]')?.dataset.probeStamp ?? null);
    const cols = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.ws-grid')).gridTemplateColumns,
    );

    ok(t1 > t0, 'chunk 仍在增长（SSE 没断）', `${t0} → ${t1} 字`);
    ok(focus1 === focus0, '焦点没丢', `${focus0} → ${focus1}`);
    ok(stamp === 'x', '工作区节点是同一个（没重建）');
    ok(colsOf(cols) >= 2, '重排确实发生了（栏数 ≥2）', cols);
    await ctx.close();
  }

  // ── ④ F6 走到末栏放行 ──────────────────────────────────────
  console.log('\n④ F6：栏间循环，走到末栏把焦点交还浏览器（不 preventDefault）');
  {
    const { ctx, page } = await open(browser, 1536, 950);
    // 被接管的键在 document 捕获阶段就 stopPropagation 了，冒泡到 window 时已经没了。
    // 所以「有没有被接管」= 捕获看得见、冒泡看不见；不能只看 defaultPrevented。
    await page.evaluate(() => {
      window.__seen = [];
      window.__through = [];
      window.addEventListener('keydown', (e) => { if (e.key === 'F6') window.__seen.push(1); }, true);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F6') window.__through.push(e.defaultPrevented);
      });
      document.body.focus();
    });
    await page.keyboard.press('F6'); // → 主区
    await sleep(80);
    const p1 = await page.evaluate(() => document.activeElement?.dataset?.pane ?? null);
    await page.keyboard.press('F6'); // → 卷宗栏
    await sleep(80);
    const p2 = await page.evaluate(() => document.activeElement?.dataset?.pane ?? null);
    await page.keyboard.press('F6'); // 末栏之后：放行
    await sleep(80);
    const { seen, through } = await page.evaluate(() => ({
      seen: window.__seen.length,
      through: window.__through,
    }));
    ok(p1 === 'main', '第一下 F6 → 主区', String(p1));
    ok(p2 === 'dossier', '第二下 F6 → 卷宗栏', String(p2));
    ok(seen === 3, '三下 F6 都发出去了', `捕获到 ${seen} 次`);
    ok(through.length === 1, '前两下被接管（没冒泡出来）', `冒泡到 window 的有 ${through.length} 次`);
    ok(through[0] === false, '末栏之后放行给浏览器（未 preventDefault）', JSON.stringify(through));
    await ctx.close();
  }

  // ── ⑤ hover 不改布局高度 ────────────────────────────────────
  console.log('\n⑤ hover 只改颜色，不改布局（直接量 offsetHeight）');
  {
    const { ctx, page } = await open(browser, 1536, 950);
    const h0 = await page.evaluate(() => ({
      grid: document.querySelector('.ws-grid').offsetHeight,
      main: document.querySelector('.ws-main').offsetHeight,
      dossier: document.querySelector('.ws-dossier').offsetHeight,
      page: document.documentElement.scrollHeight,
    }));
    for (const sel of ['.ws-dossier a', '.ws-dossier button', '[data-slot="sidebar-menu-button"]']) {
      const el = await page.$(sel);
      if (el) {
        await el.hover();
        await sleep(250);
      }
    }
    const h1 = await page.evaluate(() => ({
      grid: document.querySelector('.ws-grid').offsetHeight,
      main: document.querySelector('.ws-main').offsetHeight,
      dossier: document.querySelector('.ws-dossier').offsetHeight,
      page: document.documentElement.scrollHeight,
    }));
    ok(JSON.stringify(h0) === JSON.stringify(h1), 'hover 前后四个高度一字不差', JSON.stringify(h1));
    await ctx.close();
  }

  // ── ⑥ 低调模式：标签页图标 ──────────────────────────────────
  console.log('\n⑥ 低调模式：标签页那颗徽章');
  {
    const { ctx, page } = await open(browser, 1280, 900, (c) => seedDiscreet(c, true));
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll('link')].map((l) => ({
        rel: l.getAttribute('rel'),
        href: (l.getAttribute('href') || '').slice(0, 40),
      })).filter((l) => /icon/.test(l.rel || '') || /icon/.test(l.href)),
    );
    const 真图标 = icons.filter(
      (l) => /^(icon|apple-touch-icon)$/.test(l.rel || '') && !l.href.startsWith('data:'),
    );
    const 中性 = icons.filter((l) => l.href.startsWith('data:image/svg'));
    ok(真图标.length === 0, '没有一个 rel=icon 指向真徽章', JSON.stringify(icons));
    ok(中性.length === 1, '有且只有一个中性图标', JSON.stringify(中性));
    ok(icons.length <= 4, '停用的节点没有攒堆（≤3 个 + 1 个中性）', `实测 ${icons.length} 个`);
    ok(await page.title() === '工作台', '标题仍是中性的（回归）');
    await ctx.close();
  }
  {
    // 变异臂：不开低调 → 真图标必须回来。防「把 favicon 一删了之」。
    const { ctx, page } = await open(browser, 1280);
    const 真图标 = await page.evaluate(
      () => [...document.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"]')]
        .filter((l) => !(l.getAttribute('href') || '').startsWith('data:')).length,
    );
    ok(真图标 > 0, '变异臂：低调关时真徽章在位（不是被删了）', `实测 ${真图标} 个`);
    await ctx.close();
  }

  // ── ⑦ 低调模式的键盘路径（桌面唯一入口：浮钮只在移动端渲染）────
  console.log('\n⑦ 桌面恐慌路径：双击 Esc 只开不关，⌘⇧H 双向');
  {
    const { ctx, page } = await open(browser, 1280);
    const on = () => page.evaluate(() => document.documentElement.dataset.discreet === '1');
    await page.evaluate(() => document.body.focus());

    await page.keyboard.press('Escape');
    await sleep(600); // 超过 400ms 的窗口
    await page.keyboard.press('Escape');
    await sleep(200);
    ok((await on()) === false, '两下 Esc 隔太久不算双击', '');

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(300);
    ok((await on()) === true, '400ms 内双击 Esc → 开', '');

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(300);
    ok((await on()) === true, '已开时再双击 Esc **不关**（两个方向代价不对称）', '');

    await page.keyboard.press('Control+Shift+H');
    await sleep(600);
    ok((await on()) === false, '⌘⇧H 关得掉', '');
    await ctx.close();
  }

  // ── ⑧ 减弱动效 ─────────────────────────────────────────────
  console.log('\n⑧ prefers-reduced-motion: reduce 时开合过渡降级');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1536, height: 950 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto(BASE + ASK, { waitUntil: 'networkidle' });
    await sleep(1000);
    const d = await page.evaluate(() => ({
      grid: getComputedStyle(document.querySelector('.ws-grid')).transitionDuration,
      pane: getComputedStyle(document.querySelector('.ws-dossier')).animationDuration,
    }));
    ok(parseFloat(d.grid) <= 0.001, '栅格过渡被全局兜底压掉', JSON.stringify(d));
    await ctx.close();
  }
} finally {
  await shutdown({ browser, proc });
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 条未通过`);
process.exit(fails === 0 ? 0 : 1);
