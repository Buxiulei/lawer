/**
 * 服务端文案画到页面上时不许漏出记号（2026-09-07 复审 minor 的回归位）。
 *
 * 【这一条拦的是什么】协议那几句正本文案在服务端，页面照念不另写一份——这是对的，
 * 但那些句子同时也是给 agent 读的，里头带着 `**…**`。原样 {text} 出去的形态是：
 * 用户在**最该读清的那一句**上看到四个裸星号（「点这个按钮 **不会** 注销任何东西」、
 * 「余额与套餐的处理方式 **尚未定稿** 」），而没有一处报错、类型也全对。
 *
 * 所以两道判据：
 *   ① ServerCopy 自己把记号变成粗体、不留星号，且不带记号的句子逐字不改；
 *   ② **结构守卫**：那两张卡的源码里（去掉注释后）一个 `**` 都不许剩——
 *      页面自己手写的 markdown 与"忘了过 ServerCopy"是同一种事故的两张脸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { CANCEL_BALANCE_COPY_PENDING } from '@/lib/lifecycle/account-cancel';
import { REFERRAL_DELETE_PENDING_NOTE } from '@/lib/lifecycle/referral-delete';

import { ServerCopy, splitBold } from '../serverCopy';

/** 画出来之后页面上真正看得到的那串字。 */
function rendered(text: string): string {
  const parts: string[] = [];
  const collect = (n: ReactNode): void => {
    if (typeof n === 'string' || typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n as ReactNode[]) collect(c);
      return;
    }
    if (!isValidElement(n)) return;
    collect((n.props as { children?: ReactNode }).children);
  };
  collect(ServerCopy({ text }) as ReactNode);
  return parts.join('');
}

/** 树里有没有真的画出一个 <strong>。 */
function boldCount(text: string): number {
  let n = 0;
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const c of node as ReactNode[]) walk(c);
      return;
    }
    if (!isValidElement(node)) return;
    if (node.type === 'strong') n += 1;
    walk((node.props as { children?: ReactNode }).children);
  };
  walk(ServerCopy({ text }) as ReactNode);
  return n;
}

describe('ServerCopy：把记号画成粗体，不把记号画给用户', () => {
  it('不带记号的句子逐字不改（与直接 {text} 等价）', () => {
    const plain = '撤回后不再记录新的情绪档位。已经记下的不会被这一步删掉。';
    expect(rendered(plain)).toBe(plain);
    expect(boldCount(plain)).toBe(0);
  });

  it('带记号的句子：星号消失、强调仍在（变异：把 splitBold 改成 return [{bold:false,text}] → 本条红）', () => {
    const raw = '点下面这个按钮**不会**注销任何东西，只会取回一份清单。';
    expect(rendered(raw)).toBe('点下面这个按钮不会注销任何东西，只会取回一份清单。');
    expect(rendered(raw), '页面上出现了裸星号').not.toContain('*');
    expect(boldCount(raw), '星号删掉了，强调也一起没了').toBe(1);
  });

  it('一句里多处强调都认得（切法本身直接验一次）', () => {
    expect(splitBold('a**b**c**d**e')).toEqual([
      { bold: false, text: 'a' },
      { bold: true, text: 'b' },
      { bold: false, text: 'c' },
      { bold: true, text: 'd' },
      { bold: false, text: 'e' },
    ]);
  });

  it('落单的星号原样留着，不吞字也不造一个空的粗体段', () => {
    expect(rendered('注销之后 138****8000 这个号码就不在了')).toBe(
      '注销之后 138****8000 这个号码就不在了',
    );
    expect(rendered('**')).toBe('**');
  });

  it('页面真的会遇到的那两句，画出来都不带星号（不是拿造出来的例子自证）', () => {
    for (const copy of [CANCEL_BALANCE_COPY_PENDING, REFERRAL_DELETE_PENDING_NOTE]) {
      expect(copy, '这句正本里本来就没有记号，本条判据在空转').toContain('**');
      expect(rendered(copy), '这一句原样画出去会露出星号').not.toContain('*');
    }
  });
});

describe('结构守卫：这两张卡的源码里不许留裸 markdown', () => {
  const UI_ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const CARDS = [
    '(app)/settings/_components/DataRightsCard.tsx',
    '(app)/settings/_components/ReferralCard.tsx',
  ];

  /** 去掉块注释（含 JSX 的 {/* … *\/}）与行注释；剩下的就是会画到屏幕上的那部分。 */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each(CARDS)('%s 的代码里一个 ** 都不剩（变异：把一句服务端文案直接 {text} 出去 → 本条红）', (rel) => {
    const src = fs.readFileSync(path.join(UI_ROOT, rel), 'utf-8');
    // 对照臂：这个文件确实读到了，而且注释里本来是有星号的（不然剥离逻辑写反了也全绿）
    expect(src.length).toBeGreaterThan(500);
    expect(src, '抬头注释里连一处强调都没有？请确认读到的是同一个文件').toContain('**');
    expect(stripComments(src), '代码里留了裸 markdown，页面会原样画出四个星号').not.toContain('**');
  });
});
