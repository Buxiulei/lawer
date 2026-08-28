import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **子集覆盖守卫。**
 *
 * 落地页衬线标题用自托管子集字体，里面只有生成那一刻用到的字。
 * 谁改一句静态文案、多出一个新字，那个字**不报错、不缺字**——
 * 它会静默掉回系统衬线栈：在有宋体的机器上几乎看不出来，
 * 在没有宋体的安卓上则变成「一句话里一半衬线一半黑体」的缺字混排。
 *
 * **这是「产物看起来完全正常」的又一种形态**，所以用测试挡：
 * 静态文案字符集必须 ⊆ 子集字符集，超集即报红，
 * 提示去跑 `scripts/fonts/subset-serif.sh` 重新生成。
 */
const APP_ROOT = path.resolve(__dirname, '../../..');
const CHARS_FILE = path.resolve(APP_ROOT, '../scripts/fonts/landing-chars.txt');
/**
 * 取值范围要与"会用子集字体显示出来的文字"对齐，不能更宽：
 * - `alt` / `aria-label` / `title` **不排版**（图片挂了才显示 alt，那时本就走系统栈），
 *   把它们算进来会逼着子集收录一堆永远不会用衬线渲染的字。
 * - `_mock/authpay.ts` 里只有 `DISCLAIMER_TEXT` 上了这一页，套餐说明那些常量没有。
 */
const PAGE = path.resolve(__dirname, '../page.tsx');
const AUTHPAY = path.resolve(__dirname, '../_mock/authpay.ts');

function stripNonRendered(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\b(?:alt|aria-label|title)\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\})/g, '');
}

function cjkOf(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripNonRendered(src).matchAll(
    /'([^'\\]*)'|"([^"\\]*)"|`([^`\\$]*)`|>([^<{}]+)</g,
  )) {
    for (const ch of m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') {
      if (ch >= '一' && ch <= '鿿') out.add(ch);
    }
  }
  return out;
}

/** 只取 DISCLAIMER_TEXT 这一个常量的值，不是整份 authpay */
function disclaimerCjk(src: string): Set<string> {
  const m = src.match(/DISCLAIMER_TEXT\s*=\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/);
  const out = new Set<string>();
  for (const ch of m?.[1] ?? m?.[2] ?? m?.[3] ?? '') {
    if (ch >= '一' && ch <= '鿿') out.add(ch);
  }
  return out;
}

describe('落地页衬线子集覆盖', () => {
  it('字符清单存在', () => {
    expect(fs.existsSync(CHARS_FILE)).toBe(true);
  });

  it('静态文案里的每个汉字都在子集里', () => {
    const subset = new Set(fs.readFileSync(CHARS_FILE, 'utf8'));
    const used = new Set([
      ...cjkOf(fs.readFileSync(PAGE, 'utf8')),
      ...disclaimerCjk(fs.readFileSync(AUTHPAY, 'utf8')),
    ]);
    const missing = [...used].filter((ch) => !subset.has(ch));
    expect(missing.join('')).toBe('');
  });

  it('子集字体在且非空', () => {
    for (const n of ['tubashu-serif-700']) {
      const p = path.resolve(APP_ROOT, 'public/fonts', `${n}.woff2`);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(10_000);
    }
  });
});
