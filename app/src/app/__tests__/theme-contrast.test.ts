import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compile } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

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
const CSS_PATH = path.resolve(SRC, 'app/globals.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');

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
  /* `--surface-2` 是输入框、引用块、次级面板的底（Composer/NodeSheet/StepPreview
     以及 input/textarea/select 的 bg-muted 都落在它上面），此前一条配对都没有——
     仪器整块看不见这个底，改主色时它上面的字与边框会静默变坏。 */
  { name: '正文压次级底', fg: '--ink', bg: '--surface-2', min: 4.5 },
  { name: '辅助字压次级底', fg: '--ink-2', bg: '--surface-2', min: 4.5 },
  { name: '主色字压次级底', fg: '--primary-ink-on-surface', bg: '--surface-2', min: 4.5 },
];

/** 非文字与禁用件：3 就够 */
const UI_PAIRS: Pair[] = [
  { name: '禁用控件的字压自己的底', fg: '--disabled-ink', bg: '--disabled-surface', min: 3 },
  { name: '实心主色底相对卡片底', fg: '--primary', bg: '--surface', min: 3 },
  { name: '实心主色底相对页面底', fg: '--primary', bg: '--bg', min: 3 },
  /* 焦点框。**压 --surface-2 这条是主判据**：input/textarea/select/Composer 都是
     `focus:outline-none` + `focus:border-focus-ring`，那圈边框是它们唯一的焦点指示，
     而它们的底正是 --surface-2（bg-muted → --surface-2）。另两条给 `:focus-visible`
     描边——outline-offset 让线落在父元素底上，父底是 surface 或 bg。 */
  { name: '焦点框压输入框底', fg: '--focus-ring', bg: '--surface-2', min: 3 },
  { name: '焦点框压卡片底', fg: '--focus-ring', bg: '--surface', min: 3 },
  { name: '焦点框压页面底', fg: '--focus-ring', bg: '--bg', min: 3 },
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

  /**
   * 「浅色一字不变」是从 `--primary` 拆出这两个 token 的**全部前提**——
   * 拆分的正当性就建立在"浅色渲染结果与拆之前逐像素相同"上，这句话在 globals.css 里
   * 写了三处注释，却一条断言都没有。有人日后把浅色的 `--primary-ink-on-surface` 或
   * `--focus-ring` 调成"更好看的"另一个值，浅色就悄悄换了观感，
   * 而上面那组对比度断言照样全绿（新值多半也 ≥4.5）。这里把等式本身钉住。
   */
  it('浅色下拆出来的 token 逐值等于 --primary', () => {
    const light = merge(...LIGHT_BLOCKS);
    const primary = resolve(light, '--primary');
    for (const token of ['--primary-ink-on-surface', '--focus-ring']) {
      const got = resolve(light, token);
      expect(
        got,
        `浅色 ${token} 解出来是 ${got}，不等于 --primary(${primary})。` +
          `这两个 token 是为了解开**暗色**的矛盾才从 --primary 拆出来的，` +
          `拆分的前提是「浅色渲染结果一字不变」——浅色要改就三个一起改，` +
          `只动其中一个等于偷偷改了浅色观感。`,
      ).toBe(primary);
    }
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

  /**
   * 焦点框是另一条"token 值全对、屏幕上仍然坏"的路：input/textarea/select/Composer
   * 都写了 `focus:outline-none`，把浏览器默认焦点环关掉了，那圈边框于是成为它们**唯一**的
   * 焦点指示（2.4.7 焦点可见）。它压的底是输入框自己的 `--surface-2`，
   * 而 `--primary` 为了在暗色下托住白字被压到 #be4b67，压 --surface-2 只有 **2.77**，
   * 过不了 1.4.11 的 3:1——键盘用户看不出焦点落在哪个框里。焦点色一律走 `--focus-ring`。
   *
   * 两个方向都要咬：**不许退回 `focus:border-primary`**，且**关掉 outline 的地方必须有边框**
   * （只删掉焦点边框、留着 `focus:outline-none`，负向那条照样全绿，而屏幕上一点焦点指示都没有）。
   *
   * ⚠ `focus:` 与 `focus-visible:` 两个前缀都得数进来。Tailwind 里它们是两个变体，
   * 关 outline 的效果**一模一样**，而这条守卫原来只认 `focus:`——
   * 把 `focus:outline-none` 换成 `focus-visible:outline-none` 再把边框删掉，
   * 屏幕上焦点指示全没了，这条却一声不吭地全绿（复审官 R7b 实测于 select.tsx）。
   * 判据认的必须是**行为**（有没有关掉默认焦点环），不是某一个前缀的拼写。
   */
  it('焦点指示走 --focus-ring，且关掉 outline 的控件都留着它', () => {
    const back: string[] = [];
    const naked: string[] = [];
    for (const f of sourceFiles(SRC)) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const at = `${path.relative(SRC, f)}:${i + 1}`;
          if (/\bfocus(-visible)?:border-primary\b(?!-)/.test(line)) back.push(at);
          if (
            /\bfocus(-visible)?:outline-none\b/.test(line) &&
            !/\bfocus(-visible)?:border-focus-ring\b/.test(line)
          ) {
            naked.push(at);
          }
        });
    }
    expect(
      back.length === 0
        ? ''
        : `这些地方把 focus:border-primary 当焦点框用：${back.join('、')}。` +
          `--primary 是实心底色，暗色下压输入框底 --surface-2 只有 2.77:1，过不了 1.4.11 的 3:1。` +
          `改成 focus:border-focus-ring——浅色下两者逐值相同，改完浅色渲染结果不变。`,
    ).toBe('');
    expect(
      naked.length === 0
        ? ''
        : `这些地方写了 focus(-visible):outline-none 却没有 focus(-visible):border-focus-ring：${naked.join('、')}。` +
          `关掉浏览器默认焦点环之后，边框是这个控件仅剩的焦点指示，删了就等于没有焦点可见（2.4.7）。` +
          `要么把 focus:border-focus-ring 加回同一行，要么别关 outline。`,
    ).toBe('');
  });
});

/**
 * **类名 → utility 真编译**这一跳。
 *
 * 上面所有断言读的都是 globals.css 的**源文本**和组件里的**类名**，中间那一跳没人看：
 * `@theme inline` 把 `--x` 注册成 `--color-x`，Tailwind 才据此生成 `.bg-x` / `.text-x` /
 * `.border-x`。把 `@theme inline` 里 `--color-disabled-surface: var(--disabled-surface);`
 * 删掉一行，token 断言 31 条全绿，而 `.bg-disabled-surface` 整条不生成、禁用按钮
 * 掉回上一层底色（复审官实测 1.46:1）。所以这里真的跑一遍 Tailwind 编译器。
 *
 * 注：`@theme inline` 的语义就是**把值内联掉**，产物里不会留下 `--color-disabled-surface`
 * 这个名字。映射在不在，只能从"它该生成的 utility 在不在、指的是不是那个 token"上观察，
 * 而这恰好就是删掉映射行时唯一变化的东西。
 */
describe('Tailwind 编译产物', () => {
  /**
   * 每条都是组件里**真实写着**的类名，连变体前缀一起编译——
   * 判据必须钉在产线用的那个字符串上，否则测的是一个只有测试自己用的类名。
   */
  const UTILITIES = [
    {
      cls: 'disabled:bg-disabled-surface',
      token: '--disabled-surface',
      where: 'components/shadcn/button.tsx',
    },
    {
      cls: 'disabled:text-disabled-ink',
      token: '--disabled-ink',
      where: 'components/shadcn/button.tsx',
    },
    { cls: 'focus:border-focus-ring', token: '--focus-ring', where: 'components/shadcn/input.tsx' },
    {
      cls: 'text-primary-ink-on-surface',
      token: '--primary-ink-on-surface',
      where: 'app/page.tsx',
    },
  ];

  /** 把编译产物切成最内层的 `选择器 { 声明 }`，选择器里的 CSS 转义反斜杠去掉好比对 */
  function innermostRules(css: string): Array<{ sel: string; body: string }> {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      sel: m[1].replace(/\\/g, ''),
      body: m[2],
    }));
  }

  let built = '';

  beforeAll(async () => {
    const req = createRequire(path.join(APP_ROOT, 'package.json'));
    const TW_DIR = path.dirname(req.resolve('tailwindcss/package.json'));
    // globals.css 只 `@import 'tailwindcss'`，它自己再相对 import theme/preflight/utilities
    const loadStylesheet = async (id: string, base: string) => {
      const file = id.startsWith('tailwindcss')
        ? path.resolve(TW_DIR, id.slice('tailwindcss'.length).replace(/^\//, '') || 'index.css')
        : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
    };
    const compiler = await compile(CSS, { base: path.dirname(CSS_PATH), loadStylesheet });
    built = compiler.build(UTILITIES.map((u) => u.cls));
  });

  for (const u of UTILITIES) {
    it(`${u.cls} 编译成真规则并指向 ${u.token}`, () => {
      expect(
        fs.readFileSync(path.resolve(SRC, u.where), 'utf8'),
        `${u.where} 里已经不写 ${u.cls} 了——这条判据钉的类名得跟着产线走，` +
          `要么把判据改到新类名上，要么这次改动本身就漏了一处。`,
      ).toContain(u.cls);

      const hit = innermostRules(built).find((r) => r.sel.includes(`.${u.cls}`));
      expect(
        hit,
        `Tailwind 没有为 ${u.cls} 生成任何规则。多半是 globals.css 的 @theme inline 里少了` +
          ` --color-${u.token.slice(2)}: var(${u.token}); 这一行——` +
          `没有这条映射，类名就只是一串没人认识的字符串，页面照常渲染、颜色掉回上一层。`,
      ).toBeDefined();
      expect(
        hit!.body,
        `${u.cls} 生成出来了，但声明是「${hit!.body.trim()}」，没有指向 ${u.token}。`,
      ).toContain(`var(${u.token})`);
    });
  }
});
