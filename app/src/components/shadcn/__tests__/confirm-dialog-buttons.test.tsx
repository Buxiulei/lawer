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
import { buttonVariants } from '../button';
import { cn } from '../utils';

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

  it('两钮最终类串里 clamp 活着（tailwind-merge 同组后者胜，16px 必须被顶掉）', () => {
    // 挡的是「有人把 buttonVariants 整串塞进 className」：className 排在 cn() 最后，
    // buttonVariants 默认 size md 带 text-[16px]，跟 clamp 同属字号组，后者胜，
    // 于是主按钮字号钉死 16px、次按钮照常缩 —— 360 上 16 vs 14.76，320 上 16 vs 14。
    // 这里就地跑一次 twMerge，把「谁在后面」这件事钉住，不用等浏览器。
    const layout = /const BUTTON_LAYOUT = '([^']*)'/.exec(alertSrc)?.[1] ?? '';
    expect(layout).toMatch(/text-\[clamp\(/);
    const arms: [string, string][] = [
      ['主-danger', cn(buttonVariants({ variant: 'danger' }), layout, 'sm:order-2 sm:min-w-28')],
      ['主-primary', cn(buttonVariants({ variant: 'primary' }), layout, 'sm:order-2 sm:min-w-28')],
      ['次', cn(buttonVariants({ variant: 'outline' }), layout, 'sm:order-1 sm:min-w-24')],
    ];
    for (const [name, cls] of arms) {
      const tokens = cls.split(/\s+/);
      expect(tokens, name).toContain('text-[clamp(14px,4.1vw,16px)]');
      // 裸的 text-[16px]（buttonVariants size md 那一个）必须已被 clamp 合掉；
      // sm:text-[16px] 是另一组（带断点前缀），得留着。
      expect(tokens, name).not.toContain('text-[16px]');
      expect(tokens, name).toContain('sm:text-[16px]');
    }
  });

  it('主按钮的色板走 variant prop，ConfirmDialog 不再拿 className 覆盖', () => {
    // 挡的是「改回 className={cn(buttonVariants({variant: tone}))}」。
    expect(fnBody(alertSrc, 'AlertDialogAction')).toMatch(/buttonVariants\(\{\s*variant\s*\}\)/);
    expect(confirmSrc).toMatch(/<AlertDialogAction[^>]*variant=\{tone\}/);
    // 主按钮身上不许再挂 className，色板也不必再从 ./button 拿。
    // （不能直接搜 buttonVariants 这个词：上面那段注释里就有它。）
    expect(confirmSrc).not.toMatch(/<AlertDialogAction[^>]*className=/);
    expect(confirmSrc).not.toMatch(/^import .*from '\.\/button';$/m);
  });

  it('两个按钮各带 data-slot（浏览器判据靠它认主次，不靠 DOM 位置）', () => {
    // 挡的是「data-slot 被删掉」：g6-dialog-buttons.mjs 用它区分主次按钮。
    // 删了之后那把尺子只能退回按 DOM 位置认人，而"主次顺序反"这一类改动
    // 会让尺子跟着一起反 —— 读数一致地错，比没有尺子更糟。
    expect(fnBody(alertSrc, 'AlertDialogAction')).toMatch(/data-slot="alert-dialog-action"/);
    expect(fnBody(alertSrc, 'AlertDialogCancel')).toMatch(/data-slot="alert-dialog-cancel"/);
  });

  it('弹窗手机上全宽、电脑上收在 max-w-md（420 太窄，字段块会被挤折行）', () => {
    // 挡的是「宽度被改回一个跨断点的死数」：审核弹窗正文里是姓名/证件号那两行字段块，
    // 420px 上「WOO ALEXANDER BAI-YI」这一格会折行，折了就没法逐字比对。
    // 手机侧不设上限（w-[calc(100%-2rem)] 已经把两侧边距留够了）。
    // 只看类串字面量里的 token：注释里也会写到 max-w-md 这个词，扫全文会误判。
    const body = fnBody(alertSrc, 'AlertDialogContent');
    const tokens = [...body.matchAll(/'([^'\n]*)'/g)].flatMap((m) => m[1].split(/\s+/));
    expect(tokens).toContain('w-[calc(100%-2rem)]');
    expect(tokens).toContain('sm:max-w-md');
    // 不带断点前缀的 max-w-* 会在手机上一起生效，把「全宽」这件事悄悄取消。
    expect(tokens.filter((t) => /^max-w-/.test(t))).toEqual([]);
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

describe('全仓确认文案：静态可判定、不换行、不超 12 字', () => {
  // 【为什么要"静态可判定"这一层，而不只是量字面量的长度】
  // 老尺子只认写死的字符串（confirmLabel="确认吊销"）。凡是拼出来的它一律**看不见**：
  // `确认认定为 ${row.cert_name}`、`确认调为 ${PLAN_LABEL[p.plan]} ${p.days} 天`
  // 从头到尾都是绿的——而它们正是主理人截图里那两个把姓名/档位塞进按钮、
  // 撑得比次按钮宽一倍的东西。也就是说：越是会超长的写法，越是躲得过尺子。
  //
  // 新尺子改成先**解**再量：把每处传值解成"所有可能的最终文案"，逐条量长度。
  // 解不动的（拼了运行时的值：姓名、天数、数额）直接红——不是因为它一定超长，
  // 而是因为它的长度由数据决定，谁也担保不了 393 上不撑破。
  // 共享词表（NEUTRAL_WORD.freeze 这种模块常量）解得动，照样能用。
  const SRC_ROOT = path.resolve(__dirname, '../../../');

  const walk = (dir: string, out: string[] = [], ext = /\.tsx?$/): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out, ext);
      else if (ext.test(p)) out.push(p);
    }
    return out;
  };
  const allSources = walk(SRC_ROOT);
  // 扫的是"会渲染出按钮的地方"。测试文件自己要写坏样本（对照臂里就有一条拼姓名的），
  // 扫进来等于自己把自己判红。
  const uiFiles = allSources.filter((f) => f.endsWith('.tsx') && !f.includes(`${path.sep}__tests__${path.sep}`));

  /**
   * 全仓的模块级字符串常量表：`const NEUTRAL_WORD = { freeze: '锁定', … } as const`
   * → `NEUTRAL_WORD.freeze` ⇒ `锁定`。跨文件收（低调模式的词表就在另一个模块里），
   * 键名撞车时同值才留——两处不同值就当解不动，宁可红。
   */
  const CONSTS = new Map<string, string | null>();
  for (const f of allSources) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([^{}]*)\}\s*as const/g)) {
      for (const kv of m[2].matchAll(/(\w+)\s*:\s*'([^'\\\n]*)'/g)) {
        const key = `${m[1]}.${kv[1]}`;
        if (CONSTS.has(key) && CONSTS.get(key) !== kv[2]) CONSTS.set(key, null);
        else CONSTS.set(key, kv[2]);
      }
    }
  }

  /** 从 `=` 之后取出这处传值的完整源码：带引号的字面量，或一对配平的花括号。 */
  const takeValue = (src: string, at: number): string | null => {
    const c = src[at];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, at + 1);
      return end < 0 ? null : src.slice(at, end + 1);
    }
    if (c !== '{') return null;
    let depth = 0;
    let quote = '';
    for (let i = at; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return src.slice(at + 1, i);
    }
    return null;
  };

  /** 顶层（不在括号/字符串里）扫一遍，回调每个字符的 depth。 */
  const scanTop = (s: string, hit: (i: number, ch: string) => boolean | void) => {
    let depth = 0;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (depth === 0 && hit(i, ch) === true) return;
    }
  };

  /**
   * 把一处传值解成「所有可能的最终文案」。解不动返回 null。
   * 认：字符串字面量、三元（两支各自再解）、模板串（每个 ${} 也要解得动）、
   * 以及模块常量表里的成员。不认：函数调用、props、任何运行时才知道的值。
   */
  const resolve = (raw: string): string[] | null => {
    const s = raw.trim();
    if (!s) return null;
    // 三元：找顶层第一个 `?`（跳过 `?.` 与 `??`），再找与之配对的 `:`。
    let q = -1;
    scanTop(s, (i, ch) => {
      if (ch !== '?') return;
      if (s[i + 1] === '.' || s[i + 1] === '?' || s[i - 1] === '?') return;
      q = i;
      return true;
    });
    if (q >= 0) {
      let colon = -1;
      let level = 0;
      scanTop(s.slice(q), (i, ch) => {
        if (i === 0) return;
        if (ch === '?' && s[q + i + 1] !== '.' && s[q + i + 1] !== '?' && s[q + i - 1] !== '?') level++;
        else if (ch === ':') {
          if (level === 0) {
            colon = q + i;
            return true;
          }
          level--;
        }
      });
      if (colon < 0) return null;
      const a = resolve(s.slice(q + 1, colon));
      const b = resolve(s.slice(colon + 1));
      return a && b ? [...a, ...b] : null;
    }
    if (/^\([\s\S]*\)$/.test(s)) return resolve(s.slice(1, -1));
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      const body = s.slice(1, -1);
      return body.includes(s[0]) ? null : [body];
    }
    if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
      let out = [''];
      let i = 1;
      let lit = '';
      while (i < s.length - 1) {
        if (s[i] === '$' && s[i + 1] === '{') {
          const inner = takeValue(s, i + 1);
          if (inner === null) return null;
          const parts = resolve(inner);
          if (!parts) return null;
          out = out.flatMap((pre) => parts.map((p) => pre + lit + p));
          lit = '';
          i += inner.length + 3;
          continue;
        }
        lit += s[i++];
      }
      return out.map((pre) => pre + lit);
    }
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(s)) {
      const hit = CONSTS.get(s);
      return typeof hit === 'string' ? [hit] : null;
    }
    return null;
  };

  const sites: { where: string; raw: string }[] = [];
  for (const f of uiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(confirmLabel|cancelLabel)=/g)) {
      const at = m.index! + m[0].length;
      sites.push({ where: `${path.relative(SRC_ROOT, f)} ${m[1]}`, raw: takeValue(src, at) ?? '' });
    }
  }

  it('扫到的传值不是空集（尺子本身没瞎）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it('每一处传值都静态可判定（不许拿姓名/天数/数额拼按钮）', () => {
    const bad = sites.filter((s) => resolve(s.raw) === null).map((s) => `${s.where}: ${s.raw.trim()}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('解出来的每一种文案都不换行、长度 ≤ 12', () => {
    const bad: string[] = [];
    for (const s of sites) {
      for (const text of resolve(s.raw) ?? []) {
        if (/[\r\n]/.test(text) || [...text].length > 12) bad.push(`${s.where}: ${JSON.stringify(text)}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('对照臂：同一把尺子量坏样本必须命中、量好样本必须放行', () => {
    // 主理人截图里那两条（改之前的原样）：拼姓名 / 拼档位天数 —— 必须红。
    expect(resolve("review?.kind === 'reject'\n  ? `确认驳回并告知原因`\n  : review\n    ? `确认认定为 ${review.row.cert_name ?? '该身份'}`\n    : '确认'")).toBeNull();
    expect(resolve("p?.kind === 'gongdao' ? `确认发放 ${p.delta} 公道值` : `确认调为 ${PLAN_LABEL[p.plan]} ${p.days} 天`")).toBeNull();
    // 改之后的两条：解得出、且都在 12 字以内。
    expect(resolve("review?.kind === 'reject' ? '确认驳回' : '确认通过'")).toEqual(['确认驳回', '确认通过']);
    expect(resolve("pending?.kind === 'gongdao' ? '确认发放' : '确认调整'")).toEqual(['确认发放', '确认调整']);
    // 共享词表解得动（低调模式的「确认锁定」），别把它一起判红。
    expect(CONSTS.get('NEUTRAL_WORD.freeze')).toBe('锁定');
    expect(resolve("discreet ? `确认${NEUTRAL_WORD.freeze}` : '确认固化'")).toEqual(['确认锁定', '确认固化']);
    // 长度那条也得有牙：解得出但超 12 字的照样要被上面那条抓住。
    const long = resolve("'确认认定为 WOO ALEXANDER BAI-YI'") ?? [];
    expect(long).toHaveLength(1);
    expect([...long[0]].length).toBeGreaterThan(12);
  });
});
