import { launchIsolated, lowEndPage, seedDiscreet, sleep, BASE, treeCpuMs } from './lib.mjs';

const ROUTE = process.argv[2] || '/case/demo';
const REPEATS = Number(process.argv[3] || 3);

const COLLECT = `
window.__m = { lcp: 0, fcp: 0, cls: 0, longLoad: [], longScroll: [], phase: 'load' };
new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__m.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});
new PerformanceObserver((l)=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__m.cls+=e.value;}).observe({type:'layout-shift',buffered:true});
new PerformanceObserver((l)=>{for(const e of l.getEntries())if(e.name==='first-contentful-paint')window.__m.fcp=e.startTime;}).observe({type:'paint',buffered:true});
new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__m[window.__m.phase==='load'?'longLoad':'longScroll'].push(Math.round(e.duration));}).observe({type:'longtask',buffered:true});
`;

const F = 1000 / 60;
function frameStats(iv) {
  const dropped = iv.reduce((a, d) => a + Math.max(0, Math.round(d / F) - 1), 0);
  const s = [...iv].sort((a, b) => a - b);
  return { frames: iv.length, dropped, dropRatePct: +((dropped / (iv.length + dropped)) * 100).toFixed(1),
    fps: +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1),
    p95FrameMs: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(1), maxFrameMs: +Math.max(...iv).toFixed(1) };
}
const metricMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));

async function once(browser, discreet, rootPid) {
  const { ctx, page, cdp } = await lowEndPage(browser);
  await seedDiscreet(ctx, discreet);
  await ctx.addInitScript(COLLECT);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const t0 = Date.now();
  await page.goto(BASE + ROUTE, { waitUntil: 'load', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await sleep(1500);
  const loadMs = Date.now() - t0;

  const veil = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-veil]')];
    return { total: els.length, blurred: els.filter((e) => (getComputedStyle(e).filter || '').includes('blur')).length,
      discreetAttr: document.documentElement.dataset.discreet ?? null, title: document.title,
      scrollH: document.documentElement.scrollHeight };
  });
  const load = await page.evaluate(() => ({ ...window.__m }));

  await page.evaluate(() => { window.__m.phase = 'scroll'; document.scrollingElement.scrollTop = 0; });
  await cdp.send('Performance.enable');
  const m0 = metricMap(await cdp.send('Performance.getMetrics'));
  const cpu0 = treeCpuMs(rootPid);

  const DUR = 4200;
  const raf = page.evaluate(`new Promise((res)=>{const iv=[];let last=performance.now();const t0=last;
    function tick(now){iv.push(now-last);last=now;if(now-t0<${DUR})requestAnimationFrame(tick);else res(iv);}
    requestAnimationFrame(tick);})`);

  // 真实触摸：Input.dispatchTouchEvent 逐点派发，走浏览器输入管线（含惯性滑动）
  const tp = (type, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: 196, y, radiusX: 12, radiusY: 12, force: 1 }] });
  const swipe = (async () => {
    for (let s = 0; s < 5; s++) {
      await tp('touchStart', 760);
      for (let i = 0; i < 16; i++) { await tp('touchMove', 760 - i * 42); await sleep(11); }
      await tp('touchEnd', 760 - 15 * 42);
      await sleep(320);
    }
  })();
  const [iv] = await Promise.all([raf, swipe]);

  const cpu1 = treeCpuMs(rootPid);
  const m1 = metricMap(await cdp.send('Performance.getMetrics'));
  const after = await page.evaluate(() => ({ ...window.__m, scrolled: document.scrollingElement.scrollTop }));
  await ctx.close();

  const lt = (a) => ({ count: a.length, maxMs: a.length ? Math.max(...a) : 0, totalMs: a.reduce((x, y) => x + y, 0) });
  const d = (k) => +(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000).toFixed(1); // 秒 → ms
  return { loadMs, lcpMs: Math.round(load.lcp), fcpMs: Math.round(load.fcp), cls: +load.cls.toFixed(4),
    longLoad: lt(load.longLoad), longScroll: lt(after.longScroll), scroll: frameStats(iv),
    scrolledPx: after.scrolled,
    浏览器进程树CPUms: +(cpu1 - cpu0).toFixed(1),
    cpu: { 进程总CPUms: d('ProcessTime'), 主线程CPUms: d('ThreadTime'), 任务ms: d('TaskDuration'),
           样式重算ms: d('RecalcStyleDuration'), 布局ms: d('LayoutDuration'), 脚本ms: d('ScriptDuration') },
    veil };
}

const HEADED = process.env.HEADED === '1';
const { browser, proc } = await launchIsolated({ headed: HEADED });
const out = { headed: HEADED, route: ROUTE, repeats: REPEATS, runs: { on: [], off: [] } };
try {
  for (let i = 0; i < REPEATS; i++) for (const on of [true, false]) {
    const r = await once(browser, on, proc.pid);
    out.runs[on ? 'on' : 'off'].push(r);
    console.error(`  [${i + 1}/${REPEATS}] ${on ? 'ON ' : 'OFF'} 滚动${r.scrolledPx}px LCP=${r.lcpMs} 掉帧=${r.scroll.dropRatePct}% 树CPU=${r.浏览器进程树CPUms}ms 长任务=${r.longScroll.count}`);
  }
} finally { await browser.close().catch(() => {}); proc.kill('SIGTERM'); }
console.log(JSON.stringify(out, null, 1));
