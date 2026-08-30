import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **主题对比度守卫。**
 *
 * 色值改坏了不会报错、不会缺样式——页面照常渲染，只是暗色下的字读不出来，
 * 而改色的人多半只在自己那台开着浅色的机器上看过一眼。这是"产物看起来完全正常"
 * 的一种形态，所以用测试挡：直接从 globals.css 取 token，按 WCAG 2.x 相对亮度公式
 * 算关键配对的比值，低于阈值即报红。
 *
 * 阈值：正文 4.5（1.4.3 AA）；禁用控件 3（1.4.3 明文豁免禁用件，取"可辨"不取达标）；
 * 实心底相对页面底 3（1.4.11 非文字对比）。
 *
 * 这里只算 token 表里的配对，**不代替真机扫描**：组件把哪个 token 用在哪个底上，
 * 由本文件后半段的结构守卫和审查员的 contrast-scan 覆盖。
 */
const APP_ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(APP_ROOT, 'src');
const CSS = fs.readFileSync(path.resolve(SRC, 'app/globals.css'), 'utf8');

/** 从 `{` 开始按花括号配平取出一段块体 */
function blockAt(css: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(openBraceIdx + 1, i);
    }
  }
  throw new Error(`globals.css 花括号不配平：从第 ${openBraceIdx} 字符起没有配对的 }`);
}

/** 取该块**本层**的自定义属性声明（注释与嵌套子块里的不算） */
function declsOf(body: string): Map<string, string> {
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '');
  const out = new Map<string, string>();
  for (const m of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

function blocksBySelector(re: RegExp): string[] {
  return [...CSS.matchAll(re)].map((m) => blockAt(CSS, m.index! + m[0].length - 1));
}

/** 顶格 `:root {`：浅色调色板 + shadcn 桥接层，两处都要（缩进过的那些是媒体查询里的字号档） */
const LIGHT_BLOCKS = blocksBySelector(/^:root\s*\{/gm);
/** `@media (prefers-color-scheme: dark)` 里的那份 */
const DARK_MEDIA_BLOCKS = blocksBySelector(/^[ \t]*:root:not\(\.light\)\s*\{/gm);
/** `.dark` class 里的那份（手动切主题走这条） */
const DARK_CLASS_BLOCKS = blocksBySelector(/^\.dark\s*\{/gm);

function merge(...blocks: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) for (const [k, v] of declsOf(b)) out.set(k, v);
  return out;
}

/** 顺着 var() 链找到字面色值 */
function resolve(vars: Map<string, string>, name: string, seen = new Set<string>()): string {
  const raw = vars.get(name);
  if (raw === undefined) {
    throw new Error(`globals.css 的这份变量表里没有 ${name}：token 被删了或名字拼错了，补回来即可`);
  }
  const m = raw.match(/^var\((--[\w-]+)\)$/);
  if (!m) return raw;
  if (seen.has(name)) throw new Error(`${name} 的 var() 引用成环，顺着链改掉其中一环`);
  seen.add(name);
  return resolve(vars, m[1], seen);
}

function relLum(hex: string): number {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`对比度只算得了 6 位十六进制色值，这里拿到的是「${hex}」`);
  const n = parseInt(m[1], 16);
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Pair = { name: string; fg: string; bg: string; min: number };

/** 正文级：必须 ≥4.5 */
const TEXT_PAIRS: Pair[] = [
  { name: '实心主色底上的白字', fg: '--on-primary', bg: '--primary', min: 4.5 },
  { name: '主色字压卡片底', fg: '--primary-ink-on-surface', bg: '--surface', min: 4.5 },
  { name: '主色字压页面底', fg: '--primary-ink-on-surface', bg: '--bg', min: 4.5 },
  { name: '主色字压牛皮纸', fg: '--primary-ink-on-surface', bg: '--kraft', min: 4.5 },
  { name: '强调字压主色淡底', fg: '--primary-ink', bg: '--primary-wash', min: 4.5 },
  { name: '强调字压卡片底', fg: '--primary-ink', bg: '--surface', min: 4.5 },
];

/** 非文字与禁用件：3 就够 */
const UI_PAIRS: Pair[] = [
  { name: '禁用控件的字压自己的底', fg: '--disabled-ink', bg: '--disabled-surface', min: 3 },
  { name: '实心主色底相对卡片底', fg: '--primary', bg: '--surface', min: 3 },
  { name: '实心主色底相对页面底', fg: '--primary', bg: '--bg', min: 3 },
];

const THEMES: Array<[string, Map<string, string>]> = [
  ['浅色', merge(...LIGHT_BLOCKS)],
  ['暗色(系统偏好)', merge(...LIGHT_BLOCKS, ...DARK_MEDIA_BLOCKS)],
  ['暗色(.dark)', merge(...LIGHT_BLOCKS, ...DARK_CLASS_BLOCKS)],
];

describe('主题 token 对比度', () => {
  it('三份变量表都解析出来了', () => {
    expect(LIGHT_BLOCKS.length).toBeGreaterThanOrEqual(1);
    expect(DARK_MEDIA_BLOCKS.length).toBe(1);
    expect(DARK_CLASS_BLOCKS.length).toBe(1);
  });

  for (const [theme, vars] of THEMES) {
    for (const p of [...TEXT_PAIRS, ...UI_PAIRS]) {
      it(`${theme}：${p.name} ≥ ${p.min}`, () => {
        const fg = resolve(vars, p.fg);
        const bg = resolve(vars, p.bg);
        const ratio = Math.round(contrast(fg, bg) * 100) / 100;
        expect(
          ratio,
          `${theme} ${p.fg}(${fg}) 压 ${p.bg}(${bg}) 实测 ${ratio}:1，` +
            `不到 ${p.min}——改 globals.css 里这两个 token 的明度（色相别动），不要改组件`,
        ).toBeGreaterThanOrEqual(p.min);
      });
    }
  }

  /**
   * 暗色调色板在文件里有**两份逐值相同的拷贝**（`@media prefers-color-scheme` 一份、
   * `.dark` 一份），改一份忘另一份的后果是"跟随系统时对了、手动切暗色还是坏的"——
   * 两条进法长得一样，肉眼比不出来。这里逐条比对，漏改即报红。
   */
  it('两份暗色变量表逐条一致', () => {
    const media = [...declsOf(DARK_MEDIA_BLOCKS[0])].sort();
    const cls = [...declsOf(DARK_CLASS_BLOCKS[0])].sort();
    expect(cls).toEqual(media);
  });
});

describe('token 用法结构守卫', () => {
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue; // 断言文本自己会带上这些类名
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sourceFiles(p, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(p);
    }
    return acc;
  }

  /**
   * `--primary` 是**实心底色**，它得托住白字，所以暗色下必须够暗；
   * 主色文字压在页面底上则要够亮。同一个 token 满足不了两头（白字要它的相对亮度
   * ≤0.183，压 surface 要 ≥0.229，区间为空），所以主色文字一律走
   * `text-primary-ink-on-surface`，`text-primary` 不再有合法用法。
   */
  it('没有组件把 text-primary 当前景字用', () => {
    const hits: string[] = [];
    for (const f of sourceFiles(SRC)) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\btext-primary\b(?!-)/.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
        });
    }
    expect(
      hits.length === 0
        ? ''
        : `这些地方还在用 text-primary：${hits.join('、')}。` +
          `text-primary 取的是实心底色 --primary，暗色下压卡片底只有 3.60:1，正文读不出来。` +
          `改成 text-primary-ink-on-surface——浅色下两者逐值相同，改完浅色渲染结果不变。`,
    ).toBe('');
  });

  /**
   * 禁用态一旦回到整体 opacity，底和字会一起冲淡，上面那组 token 对比度断言
   * 照样全绿（token 值没动），屏幕上却仍是 2.35:1。所以这条盯的是用法本身。
   */
  it('Button 禁用态不靠整体 opacity', () => {
    const btn = fs.readFileSync(path.resolve(SRC, 'components/shadcn/button.tsx'), 'utf8');
    expect(
      /disabled:opacity-/.test(btn)
        ? 'button.tsx 又回到了 disabled:opacity-*：整体降透明把底和字一起冲淡，' +
          '实测红底白字降到 45% 只剩 2.35:1。' +
          '改回 disabled:bg-disabled-surface + disabled:text-disabled-ink 这一对显式 token。'
        : '',
    ).toBe('');
    expect(btn).toContain('disabled:bg-disabled-surface');
    expect(btn).toContain('disabled:text-disabled-ink');
  });
});
