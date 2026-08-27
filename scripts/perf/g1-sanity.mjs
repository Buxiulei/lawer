import { launchIsolated, lowEndPage, seedDiscreet, sleep, BASE, treeCpuMs } from './lib.mjs';

/**
 * 仪器灵敏度检验：如果连 blur(40px) 都测不出代价，那 blur(5px) 测出 0 就不是"没代价"，
 * 而是"这台仪器看不见代价"——两者结论天差地别，必须分清。
 */
const ARMS = [
  ['OFF 无糊层', false, null],
  ['ON  blur(5px) 实际值', true, null],
  ['ON  blur(40px) 加压对照', true, 40],
  ['ON  blur(120px) 极限对照', true, 120],
];

const { browser, proc } = await launchIsolated({ headed: true });
const rows = [];
try {
  for (const [name, discreet, forceBlur] of ARMS) {
    const { ctx, page, cdp } = await lowEndPage(browser);
    await seedDiscreet(ctx, discreet);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(BASE + '/case/demo', { waitUntil: 'load', timeout: 90000 });
    await sleep(1500);
    if (forceBlur) await page.addStyleTag({ content: `[data-veil]{filter:blur(${forceBlur}px)!important}` });
    const applied = await page.evaluate(() => {
      const e = document.querySelector('[data-veil]');
      return { n: document.querySelectorAll('[data-veil]').length, filter: e ? getComputedStyle(e).filter : null };
    });
    await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
    await sleep(400);

    const cpu0 = treeCpuMs(proc.pid);
    const raf = page.evaluate(`new Promise((res)=>{const iv=[];let last=performance.now();const t0=last;
      function tick(now){iv.push(now-last);last=now;if(now-t0<4200)requestAnimationFrame(tick);else res(iv);}
      requestAnimationFrame(tick);})`);
    const tp = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 196, y, radiusX: 12, radiusY: 12, force: 1 }] });
    const swipe = (async () => { for (let s = 0; s < 5; s++) { await tp('touchStart', 760);
      for (let i = 0; i < 16; i++) { await tp('touchMove', 760 - i * 42); await sleep(11); }
      await tp('touchEnd', 760 - 15 * 42); await sleep(320); } })();
    const [iv] = await Promise.all([raf, swipe]);
    const cpu1 = treeCpuMs(proc.pid);

    const F = 1000 / 60;
    const dropped = iv.reduce((a, d) => a + Math.max(0, Math.round(d / F) - 1), 0);
    rows.push({ 档: name, 糊层数: applied.n, filter: applied.filter,
      掉帧率pct: +((dropped / (iv.length + dropped)) * 100).toFixed(1),
      帧数: iv.length, 最大帧间隔ms: +Math.max(...iv).toFixed(1),
      树CPUms: +(cpu1 - cpu0).toFixed(1),
      滚到: await page.evaluate(() => document.scrollingElement.scrollTop) });
    console.error(`  ${name.padEnd(24)} 掉帧${rows.at(-1).掉帧率pct}% CPU=${rows.at(-1).树CPUms}ms 最大帧${rows.at(-1).最大帧间隔ms}ms`);
    await ctx.close();
  }
} finally { await browser.close().catch(() => {}); proc.kill('SIGTERM'); }
console.log(JSON.stringify(rows, null, 1));
