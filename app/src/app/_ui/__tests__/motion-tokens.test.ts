/**
 * 动效 token 与降级纪律的**结构守卫**。
 *
 * 【为什么守在这一层】动效写错不会报错，只会「看起来差不多」：
 * `var(--mo-bas)` 拼错一个字母，浏览器安静地当没有这条声明，动画瞬间完成；
 * 页面里再冒出一条写死毫秒的 arbitrary class，也没有任何东西会红。
 * 这类缺陷的共同点是**产物看起来完全正常**，所以只能靠结构守卫点名。
 *
 * 每条断言都配一句正对照（先证明扫描器确实扫到了东西），
 * 否则「没找到违规」和「压根没扫到文件」在外部是同一个形状。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EASE_CSS, MOTION } from '../motion';

const SRC = path.resolve(__dirname, '../../..');
const GLOBALS = path.resolve(SRC, 'app/globals.css');
const css = fs.readFileSync(GLOBALS, 'utf8');

/** 递归收集 src 下所有 ts/tsx（含本文件所在目录以外的全部页面与组件）。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * **注释里的示例不算违规。** 这几条守卫扫的是「代码里有没有写死数字 / 有没有
 * 绕过真源」，而真源本身的文档注释里必然要把被禁的写法原样引一遍
 * （`motion.ts` 就写着 `behavior:'smooth'` 当反例）。不剥注释的话，
 * **越是把理由写清楚的文件越容易被自己的守卫点名**。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 测试文件自己会大量引用被禁的写法当反例，一律不进扫描面。 */
const FILES = sources(SRC)
  .map((file) => ({
    rel: path.relative(SRC, file),
    text: stripComments(fs.readFileSync(file, 'utf8')),
  }))
  .filter(({ rel }) => !rel.includes('__tests__'));

/** 动效 token 块里定义的名字（只取那一段，不含调色板/字号那些）。 */
const DEFINED = new Set(
  [...css.matchAll(/^\s*(--(?:mo|ease)-[a-z-]+)\s*:/gm)].map((m) => m[1]),
);

describe('夹具本身', () => {
  it('确实读到了 globals.css 与整棵 src（正对照：不然下面全是空样本上的否定断言）', () => {
    expect(css.length).toBeGreaterThan(5000);
    expect(css).toContain('── 动效 v1 ──');
    expect(FILES.length).toBeGreaterThan(50);
  });
});

describe('token 定义与引用一一对应', () => {
  const referenced = new Set<string>();
  for (const { text } of FILES) {
    for (const m of text.matchAll(/var\((--(?:mo|ease)-[a-z-]+)\)/g)) referenced.add(m[1]);
  }
  for (const m of css.matchAll(/var\((--(?:mo|ease)-[a-z-]+)\)/g)) referenced.add(m[1]);

  it('引用到的每个 --mo-* / --ease-* 都有定义（拼错一个字母就是静默失效）', () => {
    expect(referenced.size).toBeGreaterThan(6); // 正对照：确实扫到了引用
    const missing = [...referenced].filter((name) => !DEFINED.has(name));
    expect(missing).toEqual([]);
  });

  it('定义了的每个 token 都有人用——没人用的档位是在骗后来人「这里有个规范」', () => {
    expect(DEFINED.size).toBeGreaterThan(6);
    // JS 侧不写 var()，它走成员访问：A 路 MO.seal / MO.track（喂 gsap）、B 路 MOTION.*、
    // 两套缓动 EASE / EASE_CSS / EASE_BEZIER。这些一并算「有人用」。
    // 成员访问是**正向证明**，所以扫描面放到整棵 src（含 __tests__）——
    // MO.track 是里程碑编排的总预算上界，只被 milestone-advance-plan 的自检引用，
    // 那也是货真价实的「有人用」，不该被判成没人认领的死档位。
    const viaMirror = new Set<string>();
    for (const file of sources(SRC)) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/\b(?:MO|MOTION|EASE|EASE_CSS|EASE_BEZIER)\.([a-zA-Z]+)/g)) {
        const kebab = m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        viaMirror.add(`--mo-${kebab}`);
        viaMirror.add(`--ease-${kebab}`);
      }
    }
    // 光标那对（caret / caret-stall）没有 JS 常量，只在 CSS 的 keyframes 里走 var(--mo-caret…)
    for (const m of css.matchAll(/var\((--(?:mo|ease)-[a-z-]+)\)/g)) viaMirror.add(m[1]);
    expect(viaMirror.size).toBeGreaterThan(0); // 正对照
    const unused = [...DEFINED].filter(
      (name) => !referenced.has(name) && !viaMirror.has(name),
    );
    expect(unused).toEqual([]);
  });
});

describe('JS 镜像与 CSS 逐值一致', () => {
  /*
   * MOTION / EASE 是给 WAAPI 用的，CSS 那份是给 keyframes 用的，
   * 两份**必然会分头改**。这里钉住它们不许漂移——漂移的形态是
   * 「同一个语义在 CSS 里 180ms、在 JS 里 200ms」，肉眼永远看不出来。
   */
  it('MOTION 每一档都能在 CSS 里找到同名同值的 --mo-*', () => {
    const entries = Object.entries(MOTION);
    expect(entries.length).toBeGreaterThan(5); // 正对照
    for (const [key, ms] of entries) {
      const name = `--mo-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      const found = new RegExp(`${name}:\\s*(\\d+)ms`).exec(css);
      expect(found, `CSS 里没有 ${name}`).not.toBeNull();
      expect(Number(found?.[1]), `${name} 与 MOTION.${key} 不一致`).toBe(ms);
    }
  });

  it('EASE_CSS 每一条都能在 CSS 里找到同名同值的 --ease-*', () => {
    // 合并后 EASE 是 gsap 吃的缓动**函数**（没法和 cubic-bezier 字符串比）。
    // WAAPI/CSS 侧的镜像是 EASE_CSS（字符串），拿它对齐 CSS 的 --ease-* 字面值。
    const entries = Object.entries(EASE_CSS);
    expect(entries.length).toBeGreaterThan(2); // 正对照
    for (const [key, curve] of entries) {
      const found = new RegExp(`--ease-${key}:\\s*([^;]+);`).exec(css);
      expect(found, `CSS 里没有 --ease-${key}`).not.toBeNull();
      expect(found?.[1].trim()).toBe(curve);
    }
  });
});

describe('减弱动效的降级面', () => {
  it('全局那把 CSS 钝刀还在（它捕捉所有人忘了写的地方）', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  /*
   * 【变异核 M2】把这一条从 motion.ts 里拆掉（让 scrollBehavior 恒回 smooth），
   * motion.test.ts 会红；把调用点改回字面量 'smooth'，这一条会红。两个方向都有牙。
   */
  it('程序化滚动一律过 scrollBehavior()，字面量只剩 A7 工单认领的那一处', () => {
    const offenders = FILES.filter(({ text }) =>
      /behavior:\s*'smooth'/.test(text),
    ).map(({ rel }) => rel);
    // 正对照：扫描器确实能找到 behavior: 走 scrollBehavior() 的写法。
    // A 路调用点自带 reduce 参数（scrollBehavior(reduce) / scrollBehavior(reduce, smooth)），
    // 不再是 B 路当初的零参形式，所以这里匹配「scrollBehavior(」而不锁死括号里为空。
    expect(FILES.some(({ text }) => /behavior:\s*scrollBehavior\(/.test(text))).toBe(true);
    // Workbench 的三处归 A 路 A7 工单；这里只钉住范围**只减不增**
    expect(offenders.every((rel) => rel.includes('Workbench'))).toBe(true);
    expect(offenders.length).toBeLessThanOrEqual(1);
  });

  it('WAAPI 的不降级支只给点名例外用，且必须写清理由', () => {
    const callers = FILES.filter(
      ({ rel, text }) => !rel.endsWith('motion.ts') && /\banimateAlways\(/.test(text),
    ).map(({ rel }) => rel);
    // 目前全站只有恐慌钮那道按压环。多一处就要先说清为什么它也是「进度反馈」。
    expect(callers).toEqual(['components/shell/PanicButton.tsx']);
  });
});

describe('低调模式糊层的过渡方向（工单 B5 / G-3）', () => {
  const discreetRule =
    /html\[data-discreet='1'\] \[data-veil\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const baseRule = /\n\[data-veil\] \{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('取到了这两条规则（正对照）', () => {
    expect(discreetRule).toContain('blur(5px)');
    expect(baseRule).toContain('transition');
  });

  it('**开启方向不做过渡**——那 120ms 里屏上是可读的半糊明文，正是要防的那一帧', () => {
    expect(discreetRule).toMatch(/transition:\s*none/);
    expect(discreetRule).not.toMatch(/transition:\s*filter\s+\d/);
  });

  it('关闭方向（糊→清）保留 --mo-exit：此时没有安全窗口，柔和一点更舒服', () => {
    expect(baseRule).toMatch(/transition:\s*filter\s+var\(--mo-exit\)/);
  });

  it('点住看清 / 松手回糊两个方向都不加过渡', () => {
    const openRule =
      /\[data-veil\]\[data-veil-open\],\s*\n\s*html\[data-discreet='1'\] \[data-veil\]\[data-veil-focus\] \{([^}]*)\}/
        .exec(css)?.[1] ?? '';
    expect(openRule).toContain('filter: none'); // 正对照
    expect(openRule).toMatch(/transition:\s*none/);
  });
});

describe('动效时长不许出现现场数字', () => {
  /**
   * `duration-[600ms]` 是低调模式钮长按缩放反馈的时长，600ms = HOLD_MS 长按闸的时长，
   * **不是动效档位**（--mo-* 里没有 600ms 这一档，它是判定闸的常数、不是动效词汇，
   * 落不到任何 token 上）。这两个 shell 钮文件不归本工单（B5 只碰 PanicButton），
   * 长按缩放本身由 shell-discreet-guard.test.tsx 钉着。同 animate 存量那条：**只减不增**，
   * 名单里的可以留，名单外一律红。
   */
  const KNOWN_DURATION_MS = [
    'components/shell/ShellHeader.tsx',
    'components/shell/AppSidebar.tsx',
  ];

  it('页面里没有写死毫秒的 duration arbitrary 值（长按闸的存量只减不增）', () => {
    const offenders = FILES.filter(
      ({ rel, text }) => /\bduration-\[/.test(text) && !KNOWN_DURATION_MS.includes(rel),
    ).map(({ rel }) => rel);
    // 正对照：扫描器确实找到了 duration-[ 的写法（存量），不是空跑
    expect(FILES.some(({ text }) => /\bduration-\[/.test(text))).toBe(true);
    expect(offenders).toEqual([]);
  });

  /**
   * `animate-[fade-in_150ms_ease-out]` 这种写死毫秒的用法本轮之前就有 13 处，
   * 分散在 ActionCard 与四个 shadcn 弹层里——**那些文件不归本工单**
   * （ActionCard 归 A 路 A5，弹层还没有人认领），顺手改别人的文件是另一种错。
   * 所以这里钉的是「**只减不增**」：名单里的可以留着，名单外的一律红。
   */
  const KNOWN_LITERAL_MS = [
    'components/case/ActionCard.tsx',
    'components/shadcn/alert-dialog.tsx',
    'components/shadcn/dialog.tsx',
    'components/shadcn/dropdown-menu.tsx',
    'components/shadcn/tooltip.tsx',
  ];

  it('animate arbitrary 值的时长一律走 var(--mo-*)；写死毫秒的存量只减不增', () => {
    const offenders: string[] = [];
    let known = 0;
    for (const { rel, text } of FILES) {
      for (const m of text.matchAll(/animate-\[([^\]]+)\]/g)) {
        if (!/\d+m?s/.test(m[1])) continue;
        if (KNOWN_LITERAL_MS.includes(rel)) known += 1;
        else offenders.push(`${rel}: ${m[1]}`);
      }
    }
    // 正对照：确实扫到了 animate arbitrary 值的用法，也确实扫到了存量
    expect(FILES.some(({ text }) => /animate-\[/.test(text))).toBe(true);
    expect(known).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    expect(known).toBeLessThanOrEqual(13);
  });
});
