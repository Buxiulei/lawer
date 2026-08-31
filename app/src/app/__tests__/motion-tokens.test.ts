/**
 * **CSS 侧动效的守卫。**
 *
 * 两件事在这里钉死，别处钉不住：
 *
 * 1. **token 双写对齐。** 时长与曲线在 `globals.css` 和 `_ui/motion.ts` 各有一份，
 *    改一边忘另一边的后果是「同一个语义在 CSS 里 180ms、在 gsap 里 240ms」——
 *    没有报错，只是全站节奏悄悄裂成两套。
 *
 * 2. **减弱动效的降级真的存在。** `globals.css` 底部那条
 *    `* { animation-duration: .01ms }` 是钝刀：它只保证动画**很快结束**，
 *    不保证结束在**对的那一帧**。带位移/缩放/描线的动画必须要么整条不建
 *    （包在 `no-preference` 里），要么被一条 `reduce` 规则显式 `animation: none`。
 *    这两条都没有的动画，在减弱动效下仍然会闪一下——而那正是要防的事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EASE_BEZIER, MO, MOTION } from '../_ui/motion';

const APP_SRC = path.resolve(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(APP_SRC, 'app', 'globals.css'), 'utf8');
/** 注释里也写着时长数字，先去掉再解析，否则会把说明文字当成规则 */
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('token 双写对齐', () => {
  it('每个 --mo-* 都能在 CSS 里找到，且逐值相同（A 路 MO 与 B 路 MOTION 都逐值对齐）', () => {
    for (const [name, ms] of [...Object.entries(MO), ...Object.entries(MOTION)]) {
      const m = CSS_CLEAN.match(new RegExp(`--mo-${name}:\\s*([0-9]+)ms`));
      expect(m, `--mo-${name} 没在 globals.css 里`).not.toBeNull();
      expect(Number(m![1]), `--mo-${name}`).toBe(ms);
    }
  });

  it('CSS 里没有 motion.ts 不认识的 --mo-*（防止只加一边）', () => {
    const declared = [...CSS_CLEAN.matchAll(/--mo-([a-z-]+):/g)].map((m) => m[1]);
    // 合并后 CSS 的 --mo-* = A 路 MO ∪ B 路 MOTION ∪ 两个只在 CSS 用的光标 token（无 JS 常量）
    const known = new Set([
      ...Object.keys(MO),
      ...Object.keys(MOTION),
      'caret',
      'caret-stall',
    ]);
    expect([...new Set(declared)].sort()).toEqual([...known].sort());
  });

  it('每条 --ease-* 的控制点与 JS 同名实现逐值相同', () => {
    for (const [name, pts] of Object.entries(EASE_BEZIER)) {
      const m = CSS_CLEAN.match(new RegExp(`--ease-${name}:\\s*cubic-bezier\\(([^)]+)\\)`));
      expect(m, `--ease-${name} 没在 globals.css 里`).not.toBeNull();
      const css = m![1].split(',').map((s) => Number(s.trim()));
      expect(css, `--ease-${name}`).toEqual([...pts]);
    }
  });

  it('落章是唯一带过冲的那条（控制点 y 冲出 1）', () => {
    const overshoot = Object.entries(EASE_BEZIER).filter(([, p]) => p[1] > 1 || p[3] > 1);
    expect(overshoot.map(([n]) => n)).toEqual(['seal']);
  });
});

// ─────────────────────────────────────────────────────────────
// 减弱动效降级
// ─────────────────────────────────────────────────────────────

interface AnimationUse {
  /** 用到动画的选择器 */
  selector: string;
  /** 动画名 */
  name: string;
  /** 最近的一层 @media，没有则 null */
  media: string | null;
}

/** 极简 CSS 走一遍：只需要「哪个选择器、在哪个 @media 里、用了哪个 @keyframes」 */
function animationUses(css: string): AnimationUse[] {
  const stack: string[] = [];
  const out: AnimationUse[] = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buf.replace(/\s+/g, ' ').trim());
      buf = '';
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else if (ch === ';') {
      const decl = buf.replace(/\s+/g, ' ').trim();
      const m = decl.match(/^animation:\s*([a-zA-Z0-9_-]+)/);
      if (m && m[1] !== 'none') {
        out.push({
          selector: stack[stack.length - 1] ?? '',
          name: m[1],
          media: stack.find((s) => s.startsWith('@media')) ?? null,
        });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/** `@keyframes <name>` 里动了哪些属性 */
function keyframeProps(css: string, name: string): string {
  const i = css.indexOf(`@keyframes ${name}`);
  if (i < 0) return '';
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(i, j + 1);
    }
  }
  return '';
}

/** 被某条 `reduce` 规则显式关掉的选择器 */
function killedUnderReduce(css: string): Set<string> {
  const killed = new Set<string>();
  const stack: string[] = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buf.replace(/\s+/g, ' ').trim());
      buf = '';
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else if (ch === ';') {
      const decl = buf.replace(/\s+/g, ' ').trim();
      const inReduce = stack.some((s) => s.includes('prefers-reduced-motion: reduce'));
      if (inReduce && /^animation:\s*none/.test(decl)) {
        for (const sel of (stack[stack.length - 1] ?? '').split(',')) killed.add(sel.trim());
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return killed;
}

describe('减弱动效：带位移的动画必须真的降级', () => {
  const uses = animationUses(CSS_CLEAN);
  const killed = killedUnderReduce(CSS_CLEAN);

  it('至少解析到了本次新增的那几条，不是空跑', () => {
    const names = uses.map((u) => u.name);
    expect(names).toContain('mo-track-breath');
    expect(names).toContain('mo-check-draw');
    expect(names).toContain('mo-sweep');
    expect(names).toContain('mo-nag-in');
  });

  /**
   * 判据只管**会动的**那些：位移、缩放、旋转、描线。
   * 纯 opacity 的淡入可以吃全局钝刀——它 0.01ms 结束在 opacity:1，
   * 那正好是对的终态。位移的不行：0.01ms 结束在终点没错，但中间那一下照样甩出去了，
   * 而无限循环的更糟——钝刀把它钉在 `from` 那一帧，那一帧未必是能看的那一帧。
   */
  it('每条带位移/缩放/描线的动画，要么整条不建，要么被 reduce 显式关掉', () => {
    const moving = uses.filter((u) => {
      const body = keyframeProps(CSS_CLEAN, u.name);
      return /transform:|stroke-dashoffset:/.test(body);
    });
    expect(moving.length).toBeGreaterThan(0);
    for (const u of moving) {
      const guarded = u.media?.includes('prefers-reduced-motion: no-preference') ?? false;
      const disabled = [...killed].some((k) => u.selector.includes(k) || k.includes(u.selector));
      expect(
        guarded || disabled,
        `${u.selector} 用了 ${u.name}（带位移），却既没包在 no-preference 里、也没有 reduce 关掉它`,
      ).toBe(true);
    }
  });

  /**
   * 全站唯一的无限循环单独钉一条：钝刀让它停在 `from`（opacity .45），
   * 在浅色底上几乎看不见，等于「进行中」那一格的心跳静音了。
   * 必须有一条 reduce 规则把它停在看得见的那一档。
   */
  it('「进行中」呼吸环在减弱动效下停在一个明确的、看得见的静止态', () => {
    const m = CSS_CLEAN.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.mo-breath::after \{([^}]*)\}/,
    );
    expect(m, '.mo-breath::after 缺少 reduce 规则').not.toBeNull();
    expect(m![1]).toMatch(/animation:\s*none/);
    const op = m![1].match(/opacity:\s*([0-9.]+)/);
    expect(op, 'reduce 下必须显式钉死停在哪一档').not.toBeNull();
    expect(Number(op![1])).toBeGreaterThan(0.45);
  });

  it('全站无限循环只有这几条（首屏常驻的注意力税只付一次；光标那对是流式期间的瞬态例外）', () => {
    const infinite = uses.filter((u) => {
      const i = CSS_CLEAN.indexOf(`animation: ${u.name}`);
      return i >= 0 && /infinite/.test(CSS_CLEAN.slice(i, CSS_CLEAN.indexOf(';', i)));
    });
    // graph-pulse 是案情关系图里的，只在那一页且不常驻首屏；
    // [data-caret='live'/'stalled'] 是流式光标（caret-blink / caret-breath）——
    // **只在 LLM 吐字期间出现**，不是首屏常驻的注意力税，且都是纯 opacity 无位移，故列为瞬态例外。
    // 仍用「有序数组全等」：名单外冒出一条新的无限循环照样红。
    expect(infinite.map((u) => u.selector).sort()).toEqual([
      '.graph-pulse',
      '.mo-breath::after',
      "[data-caret='live']",
      "[data-caret='stalled']",
    ]);
  });
});

describe('页面里不留现场数字', () => {
  const touched = [
    'app/(app)/case/[id]/_components/MilestoneTrack.tsx',
    'app/(app)/case/[id]/_components/DeadlineTiles.tsx',
    'app/(app)/case/[id]/_components/Dashboard.tsx',
    'components/case/ActionCard.tsx',
    'components/brand/Seal.tsx',
  ];

  it.each(touched)('%s 不写死动效时长', (rel) => {
    const src = fs.readFileSync(path.join(APP_SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src, '用 --mo-* / MO 而不是现场数字').not.toMatch(/duration-\[\d+m?s\]/);
    expect(src).not.toMatch(/animate-\[[^\]]*\d+ms/);
  });
});
