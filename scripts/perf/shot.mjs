// scripts/perf/shot.mjs — 逐屏对照用的截图。自起独立 Chrome，不碰共享 profile。
//   node scripts/perf/shot.mjs <出图目录> <名字:路径:宽:高> ...
//   路径后可跟 #selector 只截该元素；宽高缺省 393x852。
//   环境变量：PERF_BASE（站点）、SHOT_DISCREET=1（开低调模式）
import fs from 'node:fs';
import path from 'node:path';
import { BASE, launchIsolated, shutdown, seedDiscreet, sleep } from './lib.mjs';

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || specs.length === 0) {
  console.error('用法：node scripts/perf/shot.mjs <出图目录> <名字:路径[#选择器][:宽[:高]]> ...');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const { browser, proc } = await launchIsolated();
try {
  for (const spec of specs) {
    const [name, target, w = '393', h = '852'] = spec.split(':');
    const [route, selector] = target.split('#');
    const ctx = await browser.newContext({
      viewport: { width: Number(w), height: Number(h) },
      deviceScaleFactor: 2,
      isMobile: Number(w) < 700,
    });
    if (process.env.SHOT_DISCREET === '1') await seedDiscreet(ctx, true);
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await sleep(400); // 让 @font-face 与入场动画落定，否则截到无衬线的一帧
    const file = path.join(outDir, `${name}.png`);
    const shot = selector ? page.locator(`#${selector}`) : page;
    await shot.screenshot({ path: file, ...(selector ? {} : { fullPage: true }) });
    console.log(`  ${file}  ${w}x${h}${selector ? ` #${selector}` : ' 全页'}`);
    await ctx.close();
  }
} finally {
  await shutdown({ browser, proc });
}
