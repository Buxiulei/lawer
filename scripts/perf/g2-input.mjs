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

  /* ── 2d 抽屉下拉关闭（工单 B2）─────────────────────────────
     入口取 /case/demo/ask 顶栏那个「案件档案」——它在未登录的 demo 上就能开，
     不依赖任何账号数据。**每一步都同时量「那个动作到底发生了没有」**（见 README 坑 1）：
     开没开、跟没跟手、松手之后到底关没关。 */
  {
    const { ctx, page, cdp } = await lowEndPage(browser);
    await seedDiscreet(ctx, false);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(BASE + '/case/demo/ask', { waitUntil: 'load', timeout: 90000 });
    await sleep(1800);

    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] });
      await sleep(50);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(700);
    };
    const openSheet = async () => {
      const b = await page.evaluate(() => {
        const e = [...document.querySelectorAll('button')].find((x) => /案件档案/.test(x.textContent || ''));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!b) return null;
      await tap(b.x, b.y);
      return page.evaluate(() => {
        const el = document.querySelector('[data-slot="sheet-content"]');
        const h = document.querySelector('[data-slot="sheet-header"]');
        if (!el || !h) return null;
        const r = el.getBoundingClientRect(), hr = h.getBoundingClientRect();
        const bar = h.querySelector('span[aria-hidden]');
        const br = bar?.getBoundingClientRect();
        return {
          高: Math.round(r.height), top: Math.round(r.top),
          抓手: br ? Math.round(br.width) + 'x' + Math.round(br.height) : '无',
          header触区高: Math.round(hr.height), headerTouchAction: getComputedStyle(h).touchAction,
          抓点: { x: Math.round(hr.x + 60), y: Math.round(hr.y + hr.height / 2) },
        };
      });
    };
    const sheetNow = () => page.evaluate(() => {
      const el = document.querySelector('[data-slot="sheet-content"]');
      return el ? { top: Math.round(el.getBoundingClientRect().top), inline: el.style.transform || '', 拖拽中: 'sheetDragging' in el.dataset } : null;
    });
    const drag = async (from, steps, step) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, radiusX: 10, radiusY: 10, force: 1 }] });
      const 跟手 = [];
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + i * step, radiusX: 10, radiusY: 10, force: 1 }] });
        await sleep(24);
        跟手.push(await sheetNow());
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(700);
      return 跟手;
    };

    const opened = await openSheet();
    if (!opened) {
      rec('抽屉下拉关闭', null, '/case/demo/ask 上没找到「案件档案」入口或抽屉没开，未能测');
    } else {
      rec('抓手条 36x4 在，且整条 header 都是热区', opened.抓手 === '36x4' && opened.header触区高 >= 44,
        `抓手 ${opened.抓手}，header 高 ${opened.header触区高}px，touch-action=${opened.headerTouchAction}`);

      const 跟手 = await drag(opened.抓点, 8, 32);
      const 跟到了 = 跟手.filter((f) => f && /translateY\((\d+)px\)/.test(f.inline)).length;
      const 最后位移 = 跟手[跟手.length - 1];
      rec('拖拽跟手：inline transform 逐帧跟着手指走', 跟到了 >= 6,
        `8 帧里有 ${跟到了} 帧写了 translateY，最后一帧 ${最后位移 ? 最后位移.inline : '(抽屉已不在)'}`);
      const 关掉了 = (await sheetNow()) === null;
      rec('拖过 25% 松手就关（**动作确实发生了**）', 关掉了,
        `拖 256px（抽屉高 ${opened.高}px，阈值 ${Math.round(opened.高 * 0.25)}px），松手后抽屉${关掉了 ? '已卸载' : '还在'}`);

      // 反向对照：拖不够不许关。没有这一条，「一拖就关」也能让上面那条通过。
      const again = await openSheet();
      if (!again) rec('拖不够会弹回不关掉', null, '第二次没能把抽屉打开，未能测');
      else {
        await drag(again.抓点, 3, 14);
        const 还在 = await sheetNow();
        rec('拖不够（<25%）会弹回，不关掉', Boolean(还在) && 还在.inline === '',
          `拖 42px（阈值 ${Math.round(again.高 * 0.25)}px），抽屉${还在 ? '还在' : '被关掉了'}，inline transform=${还在 ? (还在.inline || '(已清空)') : 'n/a'}`);
      }
    }
    await ctx.close();
  }
} finally { await shutdown({ browser, proc }); }
console.log(JSON.stringify(R, null, 1));
