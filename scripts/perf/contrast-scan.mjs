// scripts/perf/contrast-scan.mjs
// 【它量什么】一条路由 × 一个主题的**渲染后**对比度扫描，两遍：
//   ① 首屏每一段可见文字的前景/背景实际对比度（WCAG 1.4.3，正文 4.5:1、大字 3:1）；
//   ② 表单控件的边框与焦点框（WCAG 1.4.11 非文字对比 3:1）——静止态一遍、焦点态一遍。
//
// 【为什么要有它，token 单测不是已经在盯了吗】
// `app/src/app/__tests__/theme-contrast.test.ts` 读的是 globals.css 的**源文本**和
// 组件里的**类名**，它看不见：层叠之后到底哪条规则赢了、半透明叠在什么底上、
// 元素实际继承到的是哪一层 surface。那条测试与这把尺子是**两台仪器**，不互相替代：
// 单测能在 CI 里拦住"写错 token 名"，这里能拦住"token 全对、屏幕上仍然读不出来"。
//
// 【怎么跑】
//   cd app && npm ci                      # 依赖（playwright-core）在 app 包里
//   cd app && npx next build && npx next start -p 3127 &
//   node scripts/perf/contrast-scan.mjs                       # 默认 /case/demo 浅色
//   node scripts/perf/contrast-scan.mjs /case/demo dark       # 暗色
//   node scripts/perf/contrast-scan.mjs / light               # 落地页
//   PERF_TOKEN=<jwt> node scripts/perf/contrast-scan.mjs /case/demo dark   # 要登录态的路由
// 参数：`[路由] [light|dark]`。环境变量沿用本目录约定：`PERF_BASE`（默认 3127）、
// `PERF_CHROME`、`PERF_PROFILE`；另加 `PERF_TOKEN`（写进 localStorage 的 `lawer.token`，
// 不给就按匿名访客跑，需要鉴权的路由会被重定向到登录页——那时读数是登录页的，不是目标页的）。
// 退出码恒为 0：**它是尺子不是闸**，判不判合格由读的人定。
//
// 【CI 接线待议（需浏览器）】
// 本脚本要一个真的 Chrome（同 lib.mjs：不下载浏览器，自起系统 Chrome 再 connectOverCDP）
// 外加一个跑起来的构建，CI 里这两样都还没有。**故意不接 CI，也不在这里加阈值断言**——
// 现在接等于给流水线加一个"环境不齐就红"的假警报，而假警报会被人学会忽略，
// 连带把真的那次也忽略掉。要接的前提是先定：跑哪几条路由 × 哪几个主题、
// 失败阈值是"新增一条"还是"总数超 N"、以及基线存在哪。这三条没定之前不接。
//
// ⚠ 这把尺子踩过两个坑，都会**安静地给出错误读数**（改动前先看，别把它们改回去）：
//
// 1. **必须等过渡跑完再读焦点态。** 控件都带 `transition-colors duration-150`，
//    `el.focus()` 之后立刻 `getComputedStyle` 拿到的是**动画中途**的值——实测就是静止态
//    那个色。于是"焦点框"被读成跟静止态一模一样的边框，仪器一致地、安静地报出错误读数。
//    ⇒ 按元素**自己声明的**过渡时长等（不是拍一个固定数字）。
// 2. **`getComputedStyle` 返回的是活对象**，`focus()` 之后它自己也跟着变。
//    静止态必须**当场抄成字符串**，否则后面拿"焦点态 vs 静止态"一比永远相等，
//    第 188 行那条"根本没有焦点指示"的判断永远不会触发。
//
// 这两坑合起来正是当初"两台仪器都看不见 F1"的那一半原因。
import { launchIsolated, shutdown, BASE } from './lib.mjs';

const route = process.argv[2] || '/case/demo';
const themeFlag = process.argv[3] === 'dark' ? 'dark' : 'light';
const TOKEN = process.env.PERF_TOKEN || '';

const { browser, proc } = await launchIsolated();
try {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    colorScheme: themeFlag,
  });
  if (TOKEN) {
    await ctx.addInitScript(
      `try{localStorage.setItem('lawer.token', ${JSON.stringify(TOKEN)})}catch(e){}`,
    );
  }
  const page = await ctx.newPage();
  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(600);

  const results = await page.evaluate(async () => {
    function parseColor(str) {
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    }
    function relLum({ r, g, b }) {
      const f = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }
    function compositeOver(fg, bg) {
      if (fg.a >= 1) return fg;
      return {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      };
    }
    function bgOf(el) {
      let node = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        const parsed = parseColor(c);
        if (parsed && parsed.a > 0.01) return parsed;
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    /** 只看祖先的底：outline-offset 让描边落在元素**外面**，压的是父元素那层底 */
    function bgBehind(el) {
      let node = el.parentElement;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        const parsed = parseColor(c);
        if (parsed && parsed.a > 0.01) return parsed;
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    function contrast(l1, l2) {
      const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (a + 0.05) / (b + 0.05);
    }

    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const r = p.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return NodeFilter.FILTER_REJECT;
        if (r.bottom < 0 || r.top > window.innerHeight) return NodeFilter.FILTER_REJECT; // 只查首屏
        const style = getComputedStyle(p);
        if (style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    const seen = new Set();
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const effFg = compositeOver(fg, bg);
      const ratio = contrast(relLum(effFg), relLum(bg));
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const threshold = isLarge ? 3 : 4.5;
      const key = `${el.tagName}|${style.color}|${JSON.stringify(bg)}|${node.textContent.trim().slice(0, 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ratio < threshold) {
        out.push({
          text: node.textContent.trim().slice(0, 30),
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          color: style.color,
          bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
          fontSize,
          fontWeight,
          ratio: Math.round(ratio * 100) / 100,
          threshold,
        });
      }
    }

    /* ── 第二遍：控件边框与焦点框（WCAG 1.4.11 非文字对比，3:1）───────────────
       只读 color 的扫描对**边框**是全盲的，而本站的输入控件全是 `focus:outline-none`，
       那圈 border 是它们唯一的焦点指示——主色一旦为了别的用途改暗，
       焦点框会静默掉到 3:1 以下，而上面那遍文字扫描一条都不会报。
       两个态都量：静止态的边框（用来认出"这里是个输入框"）、
       拿到焦点后的边框与 outline（用来认出"焦点在这一个上"）。
       注：焦点态靠 el.focus() 触发。文本框在编程式聚焦下同样匹配 :focus-visible，
       按钮不一定，所以这里只量表单控件，按钮的描边由 token 单测那条盯。 */
    const edges = [];
    const CONTROLS = 'input:not([type=hidden]), textarea, select';
    for (const el of document.querySelectorAll(CONTROLS)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue; // 与文字那遍一致：只查首屏

      const own = bgOf(el); // 边框压的是控件自己的底
      const behind = bgBehind(el); // outline 有 offset，压的是父元素的底
      const label = `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''}`;
      const cls = (el.className || '').toString().slice(0, 80);

      const check = (state, what, colorStr, widthStr, bg) => {
        const w = parseFloat(widthStr);
        if (!(w > 0)) return; // 没画就不算指示物
        const c = parseColor(colorStr);
        if (!c || c.a < 0.01) return;
        const eff = compositeOver(c, bg);
        const ratio = contrast(relLum(eff), relLum(bg));
        if (ratio >= 3) return;
        edges.push({
          state,
          what,
          tag: label,
          cls,
          color: colorStr,
          bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
          width: w,
          ratio: Math.round(ratio * 100) / 100,
          threshold: 3,
        });
      };

      /* 【坑 2】`getComputedStyle` 返回的是**活对象**，focus() 之后它自己也跟着变；
         静止态必须当场抄成字符串，否则后面拿"焦点态 vs 静止态"一比永远相等。 */
      const live = getComputedStyle(el);
      const rest = {
        borderTopColor: live.borderTopColor,
        borderTopWidth: live.borderTopWidth,
        transitionDuration: live.transitionDuration,
      };
      check('静止', 'border', rest.borderTopColor, rest.borderTopWidth, own);

      /* 【坑 1】**必须等过渡跑完再读。** 这些控件都带 `transition-colors duration-150`，
         focus() 之后立刻 getComputedStyle 拿到的是**动画中途**的值——实测就是静止态那个色，
         于是"焦点框"被读成了跟静止态一模一样的边框，仪器会一致地、安静地报出错误的读数。
         这一坑正是"两台仪器都看不见 F1"的一半原因，所以按元素自己声明的过渡时长等。 */
      el.focus();
      const waitMs = Math.max(
        200,
        ...rest.transitionDuration.split(',').map((s) => parseFloat(s) * 1000 + 60),
      );
      await new Promise((r) => setTimeout(r, waitMs));
      const foc = getComputedStyle(el);
      check('焦点', 'border', foc.borderTopColor, foc.borderTopWidth, own);
      if (foc.outlineStyle !== 'none') {
        check('焦点', 'outline', foc.outlineColor, foc.outlineWidth, behind);
      }
      // 焦点框被 outline:none 关掉、border 又跟静止态一个色 = 根本没有焦点指示（2.4.7）
      if (foc.outlineStyle === 'none' && foc.borderTopColor === rest.borderTopColor) {
        edges.push({
          state: '焦点',
          what: '无指示',
          tag: label,
          cls,
          color: foc.borderTopColor,
          bg: `rgb(${Math.round(own.r)},${Math.round(own.g)},${Math.round(own.b)})`,
          width: parseFloat(foc.borderTopWidth),
          ratio: null,
          threshold: 3,
        });
      }
      el.blur();
    }

    return { text: out, edges };
  });

  console.log(`route=${route} theme=${themeFlag} 低于阈值的文字数量:`, results.text.length);
  console.log(JSON.stringify(results.text, null, 2));
  console.log(`route=${route} theme=${themeFlag} 低于阈值的控件边框/焦点框数量:`, results.edges.length);
  console.log(JSON.stringify(results.edges, null, 2));
  await ctx.close();
} finally {
  await shutdown({ browser, proc });
}
