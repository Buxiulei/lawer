// scripts/perf/lib.mjs
// 前端性能/交互测量工装的公共部分：自起一个**独立** Chrome、装低端机档位、量进程树 CPU。
//
// 【依赖为什么这么解析】仓库只有 app 一个 npm 包（同 scripts/reconcile.ts 的说明：
// 「依赖由 app 包提供」）。本文件在 app 之外，裸 import 'playwright-core' 解析不到
// app/node_modules，所以用 createRequire 显式锚到 app/package.json。
// 装依赖就一句：`cd app && npm ci`。
//
// 【浏览器不进依赖】playwright-core 不下载浏览器，我们也不要它下——
// 用系统 Chrome（/usr/bin/google-chrome）自起进程再 connectOverCDP。
// 这样**绝不碰**共享的 chrome-devtools-mcp / ms-playwright-mcp 浏览器，
// 也不 kill 任何现存 chrome 进程。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const { chromium } = require('playwright-core');

/** 被测站点。默认 3127，用 PERF_BASE 覆盖。 */
export const BASE = process.env.PERF_BASE || 'http://127.0.0.1:3127';
/** Chrome 用户目录。**必须独立**，默认丢临时目录，用 PERF_PROFILE 覆盖。 */
export const PROFILE =
  process.env.PERF_PROFILE || path.join(os.tmpdir(), 'lawer-perf-chrome-profile');
/** 系统 Chrome 路径，用 PERF_CHROME 覆盖。 */
export const CHROME = process.env.PERF_CHROME || '/usr/bin/google-chrome';
/** 有头模式用的 X 显示（需先 `Xvfb :95 -screen 0 400x900x24 &`）。 */
export const DISPLAY = process.env.PERF_DISPLAY || ':95';

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/**
 * 自起独立 Chrome。headed=true 时走 Xvfb——
 * **无头下帧数据是假的**（rAF 是固定 60Hz 的 BeginFrame 节拍，光栅代价不进读数），
 * 详见 README「g1-sanity 是证据不是数据」。
 */
export async function launchIsolated({ headed = false, display = DISPLAY } = {}) {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`找不到 Chrome：${CHROME}（用 PERF_CHROME 指定，或装 google-chrome）`);
  }
  const port = await freePort();
  const env = headed ? { ...process.env, DISPLAY: display } : process.env;
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    ...(headed ? ['--window-size=400,900', '--window-position=0,0'] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--metrics-recording-only', '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore', detached: false, env });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json();
        return { browser: await chromium.connectOverCDP(j.webSocketDebuggerUrl), proc, port };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGTERM');
  throw new Error(headed ? `独立 Chrome 起不来（有头模式需要 Xvfb ${display} 在跑）` : '独立 Chrome 起不来');
}

/** 低端机档位：Moto G Power 级 —— 393x852 / DPR2.625 / 触摸 / CPU 4x 降频 / Slow 4G。 */
export async function lowEndPage(browser, { cpu = 4, net_ = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (net_) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    });
  }
  return { ctx, page, cdp };
}

/** 在首帧之前落定低调模式（走 _ui/bootstrap.ts 里首屏脚本读的同一个 key）。 */
export async function seedDiscreet(ctx, on) {
  await ctx.addInitScript(`try{localStorage.setItem('lawer.discreet', ${on ? "'1'" : "'0'"})}catch(e){}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 整棵 Chrome 进程树的 OS 级 CPU 时间(ms)。合成器/光栅线程的开销只有这里看得见。 */
export function treeCpuMs(rootPid) {
  const HZ = 100;
  const kids = (pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch { return []; }
  };
  let total = 0; const seen = new Set(); const stack = [String(rootPid)];
  while (stack.length) {
    const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid);
    try {
      const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const a = f.slice(f.lastIndexOf(')') + 2).split(' ');
      total += ((Number(a[11]) + Number(a[12])) / HZ) * 1000;
    } catch {}
    stack.push(...kids(pid));
  }
  return +total.toFixed(1);
}
