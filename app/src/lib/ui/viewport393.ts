// app/src/lib/ui/viewport393.ts
// 393 宽（iPhone 15/16 逻辑宽度，本产品的移动端基准）横向溢出的**静态量尺**。
//
// ─────────────────── 先说清这把尺子量的是什么，不量什么 ───────────────────
// 【量的是】渲染出来的 HTML 里，**自己写死了一个宽于视口的宽度**的元素：
//   class 上的 `w-[420px]` / `min-w-[26rem]` / `w-[500px]` / Tailwind 数值档 `w-104`，
//   以及内联 style 的 `width:420px` / `min-width:26rem`。
// 【不量的是】真实布局。这里没有浏览器、没有排版引擎，所以量不到：长串不换行撑开、
//   表格列自然宽度、grid 内容撑破轨道、padding 累加、字体度量。**别把本文件的绿
//   读成"这一屏在 393 上不横滚"**——它只能说"没有人写死一个宽于 393 的盒子"。
//   那类真实溢出要靠真机/无头浏览器量，本仓当前没有那条通路（见交付说明）。
//
// 【为什么仍然值得有】写死宽度是这类回归里最常见、也最容易在 code review 里溜过去的一种：
// 一个 `min-w-[480px]` 在开发机的宽窗口里看不出任何异样，到 393 上就是整页横滚。
// 尺子本身有自测（viewport393.test.ts）：造一个 520px 的盒子必须被抓到，
// 放进 overflow-x-auto 容器里必须放行——一把抓不到东西的尺子比没有尺子更坏。
//
// 【放行规则】祖先里有 overflow-x-auto / overflow-x-scroll / overflow-auto / overflow-scroll
// 的，其子树整体放行：宽内容在自己的滚动容器里横滚是对的做法，页面 body 不横滚就行。

/** 移动端基准视口宽（CSS px）。393 = iPhone 15/16 逻辑宽度。 */
export const MOBILE_VIEWPORT = 393;

/** Tailwind 间距档 → px（`w-4` = 1rem = 16px），即 档位 × 4。 */
const TW_SCALE_PX = 4;
const REM_PX = 16;

/** 这些变体前缀只在更宽的断点生效，393 上不适用，整条 class 跳过。 */
const WIDER_BREAKPOINTS = new Set(['sm', 'md', 'lg', 'xl', '2xl']);

const SCROLL_CONTAINER = /\b(?:overflow-x-(?:auto|scroll)|overflow-(?:auto|scroll))\b/;

export interface WideElement {
  /** 出问题的标签名 */
  tag: string;
  /** 那一条写死宽度的声明原文（class token 或 style 片段） */
  declaration: string;
  /** 换算出来的 px */
  px: number;
}

/** `420px` / `26rem` / `420` → px；认不出返回 null。 */
function toPx(value: string, unit: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === 'px') return n;
  if (unit === 'rem' || unit === 'em') return n * REM_PX;
  return null;
}

/** 一条 class token 声明的宽度（px）；不是宽度声明返回 null。 */
function classTokenPx(token: string): number | null {
  const parts = token.split(':');
  const utility = parts.pop() ?? '';
  // 只跳 `sm:` 这种**下限**断点（393 上不生效）。`max-sm:` 是上限、在 393 上照样生效，
  // 不能一起跳——跳了就是漏报，而漏报的量尺读起来和"没问题"一模一样。
  if (parts.some((v) => WIDER_BREAKPOINTS.has(v))) return null;

  // 任意值：w-[420px] / min-w-[26rem]（max-w-[…] 是上限不是下限，不撑宽，故不匹配）
  const arbitrary = /^(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem|em)\]$/.exec(utility);
  if (arbitrary) return toPx(arbitrary[1], arbitrary[2]);

  // 数值档：w-104 / min-w-96
  const scale = /^(?:min-)?w-(\d+(?:\.\d+)?)$/.exec(utility);
  if (scale) return Number(scale[1]) * TW_SCALE_PX;

  return null;
}

/** 内联 style 里的 width / min-width（px|rem|em）。 */
function stylePx(style: string): { declaration: string; px: number }[] {
  const out: { declaration: string; px: number }[] = [];
  const re = /(?:^|;)\s*(min-width|width)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(style)) !== null) {
    const px = toPx(m[2], m[3]);
    if (px !== null) out.push({ declaration: `${m[1]}:${m[2]}${m[3]}`, px });
  }
  return out;
}

function attr(rawTag: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(rawTag);
  return m ? m[1] : '';
}

/**
 * 找出在 393 宽下**写死了过宽盒子**的元素。空数组 = 这一类溢出没有；
 * 不等于这一屏在真机上不横滚（见文件头）。
 */
export function findWideElements(html: string, viewport = MOBILE_VIEWPORT): WideElement[] {
  const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'path', 'circle']);
  const found: WideElement[] = [];
  const stack: string[] = [];
  /** 进入滚动容器时记下当时的栈深，退出到它以外才解除放行 */
  let scrollDepth = 0;

  for (const tok of html.split(/(<[^>]+>)/)) {
    if (!tok || !tok.startsWith('<')) continue;
    const name = (/^<\/?([a-zA-Z0-9]+)/.exec(tok)?.[1] ?? '').toLowerCase();
    if (!name) continue;

    if (tok.startsWith('</')) {
      stack.pop();
      if (scrollDepth > 0 && stack.length < scrollDepth) scrollDepth = 0;
      continue;
    }

    const selfClosing = tok.endsWith('/>') || VOID.has(name);
    const className = attr(tok, 'class');
    const inScroll = scrollDepth > 0;

    if (!inScroll) {
      for (const token of className.split(/\s+/)) {
        if (!token) continue;
        const px = classTokenPx(token);
        if (px !== null && px > viewport) found.push({ tag: name, declaration: token, px });
      }
      for (const s of stylePx(attr(tok, 'style'))) {
        if (s.px > viewport) found.push({ tag: name, declaration: s.declaration, px: s.px });
      }
    }

    if (selfClosing) continue;
    stack.push(name);
    if (scrollDepth === 0 && SCROLL_CONTAINER.test(className)) scrollDepth = stack.length;
  }

  return found;
}

/** 断言用的一行说明：把找到的东西点名说出来，而不是只说"有溢出"。 */
export function describeWideElements(found: readonly WideElement[]): string {
  return found.map((f) => `<${f.tag}> 的 ${f.declaration}（${f.px}px）`).join('；');
}
