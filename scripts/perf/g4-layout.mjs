import { launchIsolated, lowEndPage, sleep, BASE, shutdown } from './lib.mjs';
const { browser, proc } = await launchIsolated();
try {
  // 1440 / 1920 是批6-A 补的两档桌面基线：三栏是否排开、主区被压到多宽，
  // 只有到这两档才看得出来（1280 恒为双栏）。
  for (const w of [393, 768, 1280, 1440, 1920]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 852 }, deviceScaleFactor: 2, isMobile: w < 768, hasTouch: w < 768 });
    const page = await ctx.newPage();
    await page.goto(BASE + '/case/demo', { waitUntil: 'load', timeout: 90000 });
    await sleep(1200);
    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('*')].filter((e) => {
        const s = getComputedStyle(e);
        return s.borderRadius.startsWith('12px') && parseFloat(s.borderTopWidth) > 0 && e.getBoundingClientRect().height > 24;
      });
      const byBg = {};
      for (const c of cards) { const b = getComputedStyle(c).backgroundColor; byBg[b] = (byBg[b] || 0) + 1; }
      const grid = document.querySelector('.ws-grid');
      const tracks = grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/) : [];
      return { 页高: document.documentElement.scrollHeight, 屏高: innerHeight,
        卡片数: cards.length, 按底色分布: byBg,
        侧栏可见: !!document.querySelector('aside') && getComputedStyle(document.querySelector('aside')).display !== 'none',
        工作区栏数: tracks.filter((t) => parseFloat(t) > 0).length,
        主区宽: tracks[0] ?? null };
    });
    console.log(`${w}px → 页高 ${r.页高}px (${(r.页高 / r.屏高).toFixed(1)} 屏) | 12px圆角带边框的卡片 ${r.卡片数} 个 | 侧栏${r.侧栏可见 ? '显示' : '隐藏'}`);
    console.log(`   工作区 ${r.工作区栏数} 栏，主区 ${r.主区宽}`);
    console.log('   按底色:', JSON.stringify(r.按底色分布));
    await ctx.close();
  }
} finally { await shutdown({ browser, proc }); }
