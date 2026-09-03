/**
 * 确认弹窗的按钮排布（手机竖排 / 电脑一行）。
 *
 * **判据不全在这个文件里。** vitest 跑的是 node 环境，没有排版引擎，也没有
 * Radix 的 Portal（`AlertDialogContent` 在 SSR 下渲染成 null），所以这里量不到
 * 「两个按钮在屏幕上谁在上面、有没有溢出」——真判据是
 * `scripts/perf/g6-dialog-buttons.mjs`：真浏览器 393×852 与 1280×900 各开一次弹窗，
 * 量 footer 的 computed flex-direction、两个按钮的 rect 上下/左右关系、
 * 高度 ≥44、以及 scrollWidth ≤ clientWidth（文案没被撑出去）。
 *
 * 这个文件只做一件事：把「排布是由哪几处决定的」钉住，让任何一处被改掉时，
 * 在跑浏览器判据之前就先红一次。每条断言下面写清它挡的是哪一处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertDialogFooter } from '../alert-dialog';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const alertSrc = read('../alert-dialog.tsx');
const confirmSrc = read('../confirm-dialog.tsx');
/** 取一个顶层 function 的完整源码（到下一个顶层 function 为止）。 */
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

const evidenceSrc = read(
  '../../../app/(app)/case/[id]/evidence/_components/EvidenceLibrary.tsx',
);

describe('确认弹窗 footer 的排布', () => {
  it('窄屏竖排：footer 是 flex-col，不是 flex-row / flex-col-reverse', () => {
    // 挡的是「有人把 footer 改回一行」——主理人截图里两个按钮挤在一行就是这一处。
    const html = renderToStaticMarkup(<AlertDialogFooter />);
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.split(/\s+/)).toContain('flex-col');
    expect(cls).not.toMatch(/(^|\s)flex-row(\s|$)/);
    expect(cls).not.toMatch(/flex-col-reverse/);
    // 电脑端才回到一行、右对齐。
    expect(cls).toMatch(/sm:flex-row/);
    expect(cls).toMatch(/sm:justify-end/);
  });

  it('主按钮在 DOM 里先于次按钮（窄屏靠 DOM 顺序决定谁在上）', () => {
    // 挡的是「顺序被换回 Cancel 在前」：footer 是 flex-col（没有 reverse），
    // 所以窄屏的上下顺序 = DOM 顺序，主按钮必须写在前面。
    const action = confirmSrc.indexOf('<AlertDialogAction');
    const cancel = confirmSrc.indexOf('<AlertDialogCancel');
    expect(action).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(-1);
    expect(action).toBeLessThan(cancel);
  });

  it('电脑端用 order 把次按钮摆回左边（DOM 顺序不动）', () => {
    // 挡的是「order 被删掉」：删了之后电脑端会变成主左次右，跟全站反过来。
    const actionBody = fnBody(alertSrc, 'AlertDialogAction');
    const cancelBody = fnBody(alertSrc, 'AlertDialogCancel');
    expect(actionBody).toMatch(/sm:order-2/);
    expect(cancelBody).toMatch(/sm:order-1/);
  });

  it('窄屏两个按钮各自全宽、电脑端收回 auto', () => {
    // 挡的是「BUTTON_LAYOUT（w-full / sm:w-auto / 自动缩字号）被从某个按钮上删掉」：
    // 竖排但不等宽，就是主理人说的"两钮宽度不一"。
    const actionBody = fnBody(alertSrc, 'AlertDialogAction');
    const cancelBody = fnBody(alertSrc, 'AlertDialogCancel');
    for (const body of [actionBody, cancelBody]) {
      expect(body).toMatch(/BUTTON_LAYOUT/);
    }
    expect(actionBody).toMatch(/sm:min-w-/);
    expect(cancelBody).toMatch(/sm:min-w-/);
    expect(alertSrc).toMatch(/const BUTTON_LAYOUT = '[^']*\bw-full\b[^']*sm:w-auto[^']*'/);
  });

  it('两个按钮各带 data-slot（浏览器判据靠它认主次，不靠 DOM 位置）', () => {
    // 挡的是「data-slot 被删掉」：g6-dialog-buttons.mjs 用它区分主次按钮。
    // 删了之后那把尺子只能退回按 DOM 位置认人，而"主次顺序反"这一类改动
    // 会让尺子跟着一起反 —— 读数一致地错，比没有尺子更糟。
    expect(fnBody(alertSrc, 'AlertDialogAction')).toMatch(/data-slot="alert-dialog-action"/);
    expect(fnBody(alertSrc, 'AlertDialogCancel')).toMatch(/data-slot="alert-dialog-cancel"/);
  });

  it('弹窗底部留了安全区（窄屏贴底，home indicator 会盖住按钮）', () => {
    expect(alertSrc).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});

describe('固化弹窗的文案', () => {
  it('主按钮是「确认固化」，「不再修改」不再跟在按钮上', () => {
    // 「不再修改」已经写在标题「固化后这份证据不能再改」里，按钮上再说一遍
    // 只会把主按钮撑长、跟次按钮宽度差一截。
    expect(evidenceSrc).toMatch(/confirmLabel=\{[\s\S]{0,80}?: '确认固化'\}/);
    expect(evidenceSrc).not.toMatch(/确认固化，不再修改/);
    expect(evidenceSrc).toMatch(/cancelLabel="再检查一下"/);
  });
});

describe('全仓确认文案不许换行、不许过长', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) files.push(p);
    }
  };
  walk(path.resolve(__dirname, '../../../'));

  it('confirmLabel / cancelLabel 的字面量里没有换行，长度 ≤ 12', () => {
    // 挡的是「新加的确认文案太长，在 393 上把按钮撑破」——按钮是 whitespace-nowrap，
    // 撑破的表现是横向溢出而不是换行，肉眼在电脑上看不出来。
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(confirmLabel|cancelLabel)=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
        const text = m[2] ?? m[3] ?? m[4] ?? '';
        if (/[\r\n]/.test(text) || [...text].length > 12) {
          bad.push(`${path.relative(process.cwd(), f)}: ${JSON.stringify(text)}`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
