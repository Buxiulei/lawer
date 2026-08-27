import { launchIsolated, lowEndPage, seedDiscreet, sleep, BASE, shutdown } from './lib.mjs';

const R = [];
const rec = (name, pass, detail) => { R.push({ 项: name, 结果: pass === null ? '无法真实模拟' : pass ? 'PASS' : 'FAIL', 实测: detail });
  console.error(`  ${pass === null ? '—' : pass ? '✓' : '✗'} ${name} :: ${detail}`); };

const { browser, proc } = await launchIsolated({ headed: true });
try {
  /* ── 2a 点住即显 ───────────────────────────────────────── */
  {
    const { ctx, page, cdp } = await lowEndPage(browser);
    await seedDiscreet(ctx, true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(BASE + '/case/demo', { waitUntil: 'load', timeout: 90000 });
    await sleep(1500);

    const box = await page.evaluate(() => {
      for (const e of document.querySelectorAll('[data-veil]')) {
        const r = e.getBoundingClientRect();
        if (r.top > 120 && r.bottom < 800 && r.height > 20) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    if (!box) throw new Error('找不到可测的糊层块');
    const opened = () => page.evaluate(() => document.querySelectorAll('[data-veil-open]').length);
    const down = (y = box.y, x = box.x) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
    const move = (y, x = box.x) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
    const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await down(); await sleep(80); const quick = await opened(); await up(); await sleep(1800);
    rec('短按 80ms（低于 150ms 门槛）不揭开', quick === 0, `按住 80ms 时揭开块数=${quick}，期望 0`);

    await down(); await sleep(320); const held = await opened();
    rec('按住 320ms 揭开', held === 1, `揭开块数=${held}，期望 1`);
    await up();
    await sleep(600); const midRecover = await opened();
    rec('松手 0.6s 内仍看得见（1.5s 恢复期）', midRecover === 1, `松手 600ms 后揭开块数=${midRecover}，期望 1`);
    await sleep(1400); const afterRecover = await opened();
    rec('松手 2.0s 后重新糊上', afterRecover === 0, `揭开块数=${afterRecover}，期望 0`);

    await down(); await sleep(80); await move(box.y - 60); await sleep(300); const moved = await opened(); await up(); await sleep(1800);
    rec('门槛前位移 60px（判定为滚动）不揭开', moved === 0, `80ms 时划走、再等 300ms，揭开块数=${moved}，期望 0`);
    await ctx.close();
  }

  /* ── 2b 恐慌钮开关不对称 ────────────────────────────────── */
  {
    const { ctx, page, cdp } = await lowEndPage(browser);
    await seedDiscreet(ctx, false);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(BASE + '/case/demo', { waitUntil: 'load', timeout: 90000 });
    await sleep(1500);
    const btn = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button[aria-pressed]')].filter((e) => /低调模式/.test(e.getAttribute('aria-label') || ''));
      const b = all.find((e) => getComputedStyle(e).position === 'fixed');
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
               label: b.getAttribute('aria-label'), 同名开关数: all.length };
    });
    if (!btn) throw new Error('找不到 fixed 定位的悬浮恐慌钮');
    console.error(`    (页面上同名「低调模式」开关共 ${btn.同名开关数} 个，已锁定 fixed 悬浮钮：${btn.label})`);
    const on = () => page.evaluate(() => document.documentElement.dataset.discreet === '1');
    const tap = async (ms) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: btn.x, y: btn.y, radiusX: 10, radiusY: 10, force: 1 }] });
      await sleep(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(450);
    };
    rec('初始为关', (await on()) === false, `data-discreet=${await page.evaluate(() => document.documentElement.dataset.discreet ?? 'null')}`);
    await tap(60); const afterTapOn = await on();
    rec('单击 60ms 立刻开启（慌的时候没有第二次机会）', afterTapOn === true, `单击后 discreet=${afterTapOn}`);
    await tap(60); const stillOn = await on();
    rec('已开启时误触单击不关闭', stillOn === true, `再单击后 discreet=${stillOn}`);
    await tap(850); const afterHold = await on();
    rec('按住 850ms（>600ms 门槛）才关闭', afterHold === false, `长按后 discreet=${afterHold}`);
    await ctx.close();
  }

  /* ── 2c 图谱拖拽 ────────────────────────────────────────── */
  {
    const { ctx, page, cdp } = await lowEndPage(browser);
    await seedDiscreet(ctx, false);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const resp = await page.goto(BASE + '/case/demo/graph', { waitUntil: 'load', timeout: 90000 });
    await sleep(1800);
    const svg = await page.evaluate(() => {
      const list = [...document.querySelectorAll('svg')].map((e) => ({ e, r: e.getBoundingClientRect() }))
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      if (!list.length) return null; const { e, r } = list[0];
      if (r.width * r.height < 10000) return null; // 只剩图标 = 图谱没渲染出来
      e.setAttribute('data-probe-graph', '1');
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), vb: e.getAttribute('viewBox'),
               尺寸: Math.round(r.width) + 'x' + Math.round(r.height), svg数: list.length };
    });
    if (!svg) { rec('图谱拖拽', null, `/case/demo/graph 状态 ${resp?.status()}，页面无 svg，未能测`); }
    else {
      console.error(`    (页面 svg 共 ${svg.svg数} 个，锁定最大的 ${svg.尺寸}，viewBox=${svg.vb})`);
      const vb = () => page.evaluate(() => { const e = document.querySelector('[data-probe-graph]');
        return e ? (e.getAttribute('viewBox') ?? '') + '|' + (e.style.transform || getComputedStyle(e).transform || '') : null; });
      const before = await vb();
      const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
      await tp('touchStart', svg.x, svg.y);
      for (let i = 1; i <= 12; i++) { await tp('touchMove', svg.x - i * 9, svg.y - i * 5); await sleep(10); }
      const during = await vb();
      await tp('touchEnd', svg.x - 108, svg.y - 60);
      // 松手后每 40ms 采样，看 viewBox 何时不再变化 = 停稳耗时
      let last = await vb(); let settled = 0; const t0 = Date.now();
      for (let i = 0; i < 25; i++) { await sleep(40); const cur = await vb();
        if (cur === last) { settled = Date.now() - t0; break; } last = cur; }
      rec('图谱可拖动（viewBox 随触摸改变）', during !== before, `拖前 ${before} → 拖中 ${during}`);
      rec('松手后停稳 ≤400ms', settled <= 400, `停稳耗时约 ${settled}ms（40ms 采样粒度）`);
    }
    await ctx.close();
  }
} finally { await shutdown({ browser, proc }); }
console.log(JSON.stringify(R, null, 1));
