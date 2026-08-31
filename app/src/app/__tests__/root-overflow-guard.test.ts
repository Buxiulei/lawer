// app/src/app/__tests__/root-overflow-guard.test.ts
// 根元素横向溢出兜底的结构守卫 —— 纯文本断言，CI 不需要浏览器。
//
// 【这条测试守的是什么】BOARD 的 P-04：「落地页 fixed 容器虚高 36px 休眠项，
// 修完溢出复测仍在则 html overflow-x:clip 兜底」。兜底就写在 globals.css 的
// `html { overflow-x: clip }`，本文件守它别被删掉、也别被"顺手"换成 hidden。
// （**36px 的成因本轮未复测、未定位**；这条守的是兜底在不在，不是成因。）
//
// 【为什么不能靠肉眼】横向虚高只有几十像素，桌面上根本拽不动、截图也看不出来，
// 只有真机窄屏拖一下才会露；而它一旦回来，形态与今天完全一样——静默。
//
// 【咬的是双向，缺一个方向就白立】
//   正向：clip 被删/改没了 → 红（兜底没了，下一个越界装饰件照样让整页横晃）
//   反向：改成了 `overflow-x: hidden` → 红（hidden 把根元素变成滚动容器，
//         全站 position: sticky 当场失效：ShellHeader 顶栏、Composer 输入区、首诊下一步条）
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const GLOBALS = path.resolve(__dirname, '../globals.css');

/** 夹具找不到时的说明。**只写这一份**：自检断言与惰性读文件共用它。 */
const MISSING_FIXTURE =
  `缺什么：读不到 ${GLOBALS}。\n` +
  `为什么缺：本测试按 __dirname 上溯一级取 app/src/app（__tests__ → app），` +
  `globals.css 被改名/挪走、或本测试文件被挪到别的深度，这个相对路径就会指空。\n` +
  `怎么办：确认 app/src/app/globals.css 还在，或按本文件的新位置修正 GLOBALS。` +
  `不要因为这条红去动样式 —— 这条红说的是测试自己找错了地方。`;

/**
 * 读文件一律惰性 + 记忆化，**不放模块顶层**：顶层 readFileSync 在路径指空时于收集阶段
 * 抛 ENOENT，整个文件 0 条测试跑不起来，上面那条夹具自检连同它的三段式文案一次也不执行。
 * （同 `lib/evidence/__tests__/caddy-upload-routes.test.ts` 的教训，实测过 `0 test`。）
 */
let cachedCss: string | null = null;
function css(): string {
  if (cachedCss === null) {
    if (!fs.existsSync(GLOBALS)) throw new Error(MISSING_FIXTURE);
    // **必须先剥注释**：本文件守的 `overflow-x: hidden` 恰好被写在 globals.css 的
    // 说明注释里（解释为什么不用它）。不剥的话"反向"那条会咬到注释、恒红——
    // 守卫看起来在守，其实只是在跟一段散文较劲。
    cachedCss = fs.readFileSync(GLOBALS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  }
  return cachedCss;
}

type Rule = { selector: string; decls: string };

/**
 * 把 CSS 拆成「选择器 + 本级声明」。进块继续扫，所以 `@layer base { html { … } }`
 * 这种嵌套里的规则同样会被拆出来（`@layer base` 自己也是一条，选择器对不上而已）。
 * `decls` 剔掉下一级块，避免父规则把子规则的声明算成自己的。
 */
function rules(src: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  let selStart = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      const selector = src.slice(selStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(i + 1, depth === 0 ? j - 1 : src.length);
      out.push({ selector, decls: body.replace(/\{[\s\S]*?\}/g, '') });
      i += 1;
      selStart = i; // 继续往块里扫，捞嵌套规则
      continue;
    }
    if (src[i] === '}') {
      i += 1;
      selStart = i;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 光秃秃的 `html`（不含 `html[data-discreet='1']` 那类带条件的） */
const bareHtml = (r: Rule) => /^html$/.test(r.selector);
/** 根级选择器：`html` / `body` / `html, body` / `html[...]` 都算 */
const rootish = (r: Rule) =>
  r.selector.split(',').some((s) => /^(?:html|body)\b/.test(s.trim()));

describe('夹具自检：globals.css 与它的 html 规则必须真的找得到', () => {
  test('globals.css 在这个路径上', () => {
    expect(fs.existsSync(GLOBALS), MISSING_FIXTURE).toBe(true);
  });

  // 【为什么要单独这一条】选择器改名或整块被删时，下面两条会以"没匹配到"的形态
  // 一红一绿——反向那条恒绿（没规则就没有 hidden），看起来"只坏了一半"，
  // 而真相是这道闸整个不在了。所以先把"有没有这块规则"单独判掉。
  test('存在一条光秃秃的 `html { … }` 规则', () => {
    const found = rules(css()).filter(bareHtml);
    expect(
      found.length,
      `缺什么：globals.css 里找不到裸选择器 \`html { … }\` 的规则块。\n` +
        `为什么缺：那块被删了、被并进别的选择器（如 \`html, body\`）、` +
        `或改成了带条件的形态（如 \`html[data-theme]\`），本测试的选择器匹配就落空。\n` +
        `怎么办：确认 @layer base 里那条 \`html { … }\` 还在；若确实换了写法，` +
        `同步改本文件的 bareHtml()。这条红说的是测试没找到规则，不是样式一定错了。`,
    ).toBeGreaterThan(0);
  });
});

describe('🔴 正向：根元素必须有横向溢出兜底', () => {
  test('`html` 上声明了 overflow-x: clip', () => {
    const decls = rules(css()).filter(bareHtml).map((r) => r.decls).join('\n');
    expect(
      /overflow-x\s*:\s*clip\b/.test(decls),
      `缺什么：globals.css 的 \`html { … }\` 里没有 \`overflow-x: clip\`。\n` +
        `为什么缺：兜底被删了，或被挪到了 body / 某个容器上。BOARD 的 P-04 记着落地页有一条` +
        ` 36px 的文档虚高（成因未定位），没有这道兜底时窄屏可以左右拽动整页，` +
        `而这种虚高在桌面和截图上都看不出来——它的失败形态是静默的。\n` +
        `怎么办：把 \`overflow-x: clip\` 加回 @layer base 的 \`html\` 规则。` +
        `**别改成 hidden**（理由见下一条）。另：兜底不替代修溢出源，越界的装饰件仍要各自收进容器。`,
    ).toBe(true);
  });
});

describe('🔴 反向：根级选择器上不许出现 overflow 的 hidden', () => {
  test('html / body 上都没有 overflow(-x): hidden', () => {
    const offenders = rules(css())
      .filter(rootish)
      .filter((r) => /overflow(?:-x)?\s*:\s*hidden\b/.test(r.decls))
      .map((r) => r.selector);
    expect(
      offenders,
      `缺什么：这些根级规则把 overflow 设成了 hidden：${offenders.join(' / ') || '(无)'}。\n` +
        `为什么缺：hidden 与 clip 都止得住横向滚动，但 hidden 会把根元素变成**滚动容器**，` +
        `其中所有 \`position: sticky\` 立刻失效——本站受害的有 ShellHeader 顶栏（sticky top-0）、` +
        `「问它」的输入区 Composer、首诊的下一步操作条。顶栏不再吸顶不会报任何错，` +
        `换 hidden 的人当场看不出来。\n` +
        `怎么办：改回 \`overflow-x: clip\`。clip 按 CSS Overflow 3 不建立滚动容器，sticky 保留；` +
        `且 clip 与另一轴的 visible 可以共存，纵向滚动不受影响。`,
    ).toEqual([]);
  });
});
