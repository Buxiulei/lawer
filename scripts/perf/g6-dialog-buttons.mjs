// scripts/perf/g6-dialog-buttons.mjs
// 【确认弹窗按钮排布的判据】退出码 0/1，可直接当门禁。
//
//   cd app && npx next dev -p 5137 &
//   PERF_BASE=http://localhost:5137 node scripts/perf/g6-dialog-buttons.mjs [出图目录]
//
// PERF_BASE 必须写 localhost（不能写 127.0.0.1），原因见本目录 README 里 g5 那一段：
// Next dev 的 allowedDevOrigins 只放行 localhost，从 127.0.0.1 进来页面不 hydrate，
// 弹窗根本打不开——而失败形态是"找不到按钮"，跟真坏了长得一样。
//
// 量的是**真浏览器里的几何**，不是类串：
//   窄屏(320/360/393) footer flex-direction=column；主按钮 rect.top < 次按钮 rect.top；
//   两个按钮等宽且等于 footer 内宽；高 ≥44；文字只占一行（Range.getClientRects()===1）；
//   scrollWidth ≤ clientWidth（whitespace-nowrap 下溢出不会换行，只会横着漏出去）。
//   宽屏(1280) flex-direction=row；次按钮在左、主按钮在右；两者 top 相同。
//   主次**字号相同**且各自单行——字号这条是 360/320 才露：主按钮若拿 className 收下
//   buttonVariants 的 text-[16px]，会把 BUTTON_LAYOUT 的 clamp 合掉，主不缩次缩，
//   393 上两者都是 16px 看不出来，360 上就是 16 vs 14.76、320 上 16 vs 14。
// 另加一臂**最长文案**：把主按钮文字就地换成 12 个汉字（守卫里定的上限）再量一次，
// 证明上限内不溢出——不是靠算，是靠量。
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolated, shutdown, sleep } from './lib.mjs';

const BASE = process.env.PERF_BASE || 'http://localhost:5137';
const OUT = process.argv[2] || './g6-shots';
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const skips = [];
const ok = (name, pass, detail) => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/** 点一个文字完全匹配的可见元素。找不到返回 false（由调用方大声跳过，不静默）。 */
async function clickText(page, text, tag = 'button') {
  const el = page.locator(`${tag}:text-is(${JSON.stringify(text)})`).first();
  if ((await el.count()) === 0) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 5000 }).catch(() => {});
  return true;
}

/** 量当前打开的确认弹窗。longLabel=true 时先把主按钮文字换成 12 个汉字。 */
const measure = (longLabel) =>
  ({ longLabel }) => {
    const footer = document.querySelector('[data-slot="alert-dialog-footer"]');
    if (!footer) return { found: false };
    const btns = [...footer.querySelectorAll('button')];
    if (btns.length !== 2) return { found: false, n: btns.length };
    // 【按 data-slot 认人，不能按 DOM 位置认】早一版是"第一个就是主按钮"，
    // 于是把主次顺序反过来时脚本也跟着反，窄屏那条"主按钮在上"照样绿——
    // 仪器和被测对象一起错，读数一致且错误。M2 变异臂就是这么被抓出来的。
    const action = footer.querySelector('[data-slot="alert-dialog-action"]');
    const cancel = footer.querySelector('[data-slot="alert-dialog-cancel"]');
    if (!action || !cancel) return { found: false, n: btns.length };
    if (longLabel) action.textContent = '确认'.repeat(6);
    const oneLine = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getClientRects().length;
    };
    const box = (el) => {
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        text: el.textContent.trim(),
        top: +b.top.toFixed(1), left: +b.left.toFixed(1),
        right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1),
        w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        order: s.order, fontSize: s.fontSize, whiteSpace: s.whiteSpace,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        lines: oneLine(el),
      };
    };
    const content = document.querySelector('[data-slot="alert-dialog-content"]');
    const cb = content.getBoundingClientRect();
    return {
      found: true,
      dir: getComputedStyle(footer).flexDirection,
      footerW: +footer.getBoundingClientRect().width.toFixed(1),
      dialogBottom: +cb.bottom.toFixed(1),
      viewH: innerHeight,
      action: box(action), cancel: box(cancel),
    };
  };

async function check(page, tag, w) {
  const r = await page.evaluate(measure(false), { longLabel: false });
  if (!r.found) { ok(`${tag}@${w} 弹窗打开`, false, `footer 里 ${r.n ?? 0} 个按钮`); return null; }
  const { action: a, cancel: c } = r;
  if (w < 640) {
    ok(`${tag}@${w} footer 竖排`, r.dir === 'column', `flex-direction=${r.dir}`);
    ok(`${tag}@${w} 主按钮在上`, a.top < c.top, `主 top=${a.top} 次 top=${c.top}`);
    ok(`${tag}@${w} 两钮等宽且全宽`, Math.abs(a.w - c.w) < 0.6 && Math.abs(a.w - r.footerW) < 0.6,
      `主 ${a.w} / 次 ${c.w} / footer ${r.footerW}`);
    ok(`${tag}@${w} 弹窗底不越屏`, r.dialogBottom <= r.viewH, `底 ${r.dialogBottom} / 屏高 ${r.viewH}`);
  } else {
    ok(`${tag}@${w} footer 一行`, r.dir === 'row', `flex-direction=${r.dir}`);
    ok(`${tag}@${w} 次左主右`, c.right <= a.left + 0.6 && Math.abs(a.top - c.top) < 0.6,
      `次 right=${c.right} 主 left=${a.left} top 差 ${(a.top - c.top).toFixed(1)}`);
    ok(`${tag}@${w} 主按钮有最小宽`, a.w >= 112 - 0.6, `主宽 ${a.w}`);
  }
  // 主次字号必须一样：一大一小是"主按钮被 className 顶掉了 clamp"的唯一外显。
  ok(`${tag}@${w} 主次字号一致`, a.fontSize === c.fontSize, `主 ${a.fontSize} 次 ${c.fontSize}`);
  ok(`${tag}@${w} 主次等高`, Math.abs(a.h - c.h) < 0.6, `主 ${a.h} 次 ${c.h}`);
  for (const [n, b] of [['主', a], ['次', c]]) {
    ok(`${tag}@${w} ${n}按钮高 ≥44`, b.h >= 44, `${b.h}px`);
    ok(`${tag}@${w} ${n}按钮不换行`, b.lines === 1 && b.whiteSpace === 'nowrap',
      `行数 ${b.lines} / white-space=${b.whiteSpace}`);
    ok(`${tag}@${w} ${n}按钮不溢出`, b.scrollW <= b.clientW,
      `scrollW ${b.scrollW} ≤ clientW ${b.clientW}｜「${b.text}」`);
  }
  return r;
}

const { browser, proc } = await launchIsolated();
try {
  /** 每个场景：怎么走到弹窗。返回 false = 这一版里够不着（大声跳过）。 */
  const SCENES = [
    ['单份固化', async (page) => {
      await page.goto(`${BASE}/case/demo/evidence`, { waitUntil: 'load', timeout: 120000 });
      await sleep(2500);
      // :visible 是必须的：同一份证据在窄屏是卡片、宽屏是表格行，两套 DOM 都在，
      // 不加 :visible 会点到隐藏的那一套，表现为"点了没反应"。
      const row = page.locator('button:has-text("钉钉打卡记录"):visible').last();
      if ((await row.count()) === 0) return false;
      await row.click({ timeout: 8000 }); await sleep(1200);
      return clickText(page, '固化这份证据');
    }],
    ['清空重填', async (page) => {
      await page.goto(`${BASE}/intake`, { waitUntil: 'load', timeout: 120000 });
      await sleep(2500);
      return clickText(page, '清空重填');
    }],
    ['退出登录', async (page) => {
      // 【为什么要掐掉 /api/】localStorage 里那个 perf-fake-token 会被后端判 401，
      // _ui/api 的 401 处置就地 clearToken()，useSignedIn 翻成未登录，
      // 「退出登录」按钮当场消失——而"按钮找不到"跟"排布没坏"在日志里同形，
      // 这条场景于是一直静默跳过（复核官那轮 4 个宽度全跳）。
      // 路由级 abort 让 401 根本不会发生，登录态留在本机，按钮在。
      // 挂在 page 上不挂 context：其余场景要真数据（证据页得先列出那份证据）。
      await page.route('**/api/**', (route) => route.abort());
      await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 120000 });
      await sleep(2500);
      return clickText(page, '退出登录');
    }],
    ['关低调模式', async (page) => {
      // 全仓最长的确认文案「确认关闭，恢复明文显示」(11 字) 在这条路径上。
      await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 120000 });
      await sleep(2500);
      const sw = page.locator('#discreet-switch');
      if ((await sw.count()) === 0) return false;
      await sw.click({ timeout: 8000 });   // 开：不弹确认
      // 等开启那条 toast 自己散掉再点关：toast 浮在弹窗上面，截图会被它盖住
      // （几何读数不受影响，但人核对截图时看不见按钮）。
      await sleep(6000);
      await sw.click({ timeout: 8000 });   // 关：弹确认
      return true;
    }],
  ];

  // 320/360 是主次字号分叉才看得见的两档（clamp 在 390 以下才真的开始收）。
  for (const w of [320, 360, 393, 1280]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: w < 640 ? 852 : 900 },
      deviceScaleFactor: 2, isMobile: w < 640, hasTouch: w < 640, locale: 'zh-CN',
    });
    // 两个触发器挂在客户端状态上，不种就永远走不到（而"走不到"跟"排布没坏"同形）：
    //   退出登录 → useSignedIn()（localStorage 里的 lawer.token）
    //   清空重填 → 首诊草稿里有内容（lawer.intake.draft）
    await ctx.addInitScript(`try{
      localStorage.setItem('lawer.token','perf-fake-token');
      localStorage.setItem('lawer.intake.draft', JSON.stringify({version:1,goals:['补偿']}));
    }catch(e){}`);
    for (const [name, open] of SCENES) {
      const page = await ctx.newPage();
      let reached = false;
      try { reached = await open(page); } catch (e) { reached = false; }
      await sleep(700);
      if (!reached || (await page.locator('[data-slot="alert-dialog-footer"]').count()) === 0) {
        skips.push(`${name}@${w}`);
        console.log(`⚠️  跳过 ${name}@${w} —— 这一版里走不到（触发器没找到）`);
        await page.close(); continue;
      }
      const r = await check(page, name, w);
      await page.screenshot({ path: path.join(OUT, `${w}-${name}.png`) });
      if (r) console.log(`   主「${r.action.text}」${r.action.w}×${r.action.h} · 次「${r.cancel.text}」${r.cancel.w}×${r.cancel.h} · 字号 ${r.action.fontSize}`);
      // 最长文案臂：把主按钮换成 12 个汉字（守卫里的上限）再量
      const long = await page.evaluate(measure(true), { longLabel: true });
      if (long.found) {
        ok(`${name}@${w} 12字文案不溢出`,
          long.action.scrollW <= long.action.clientW && long.action.lines === 1,
          `scrollW ${long.action.scrollW} ≤ clientW ${long.action.clientW}，行数 ${long.action.lines}`);
        await page.screenshot({ path: path.join(OUT, `${w}-${name}-12字.png`) });
      }
      await page.close();
    }
    await ctx.close();
  }
} finally { await shutdown({ browser, proc }); }

console.log(`\n出图：${path.resolve(OUT)}`);
if (skips.length) console.log(`跳过 ${skips.length} 项：${skips.join('、')}`);
if (fails.length) { console.log(`\n❌ ${fails.length} 条不合格：\n  ${fails.join('\n  ')}`); process.exit(1); }
console.log(`\n✅ 全部通过（跳过 ${skips.length} 项）`);
