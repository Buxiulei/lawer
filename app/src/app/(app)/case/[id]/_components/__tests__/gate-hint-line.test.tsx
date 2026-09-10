/**
 * 闸提示行：一道出口闸开了火，用户要看到一句「下一步」。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * ⑥ 条号闸与 ⑨ 数值闸的 notice 里一直写着完整的第一人称出路句
 *（statute-guard.ts「回我一句『查一下这条』，我用 citation_check 把原文取回来再引给你」、
 *  value-guard.ts「回我一句『帮我算一下』」），而前端词表把这两个码映射成 null。
 * **那两句话每天都在生成、每天都被丢掉**：用户屏幕上只剩正文里一个孤零零的
 * 【条号待核验】，没有任何地方告诉他该说什么。⑤ 案号闸更彻底——它的 notice 连出路句都没写。
 *
 * 【三条判据分别钉住三件事】
 *  ① 可见文本 = 后端 message（前端不自己写一句话顶替；顶替就等于把闸的判定糊掉）；
 *  ② chip 的文字 = 后端 suggest，点它就**以那句原话发出一轮**（不是打开什么面板）；
 *  ③ 同码合并（判据在 notice.test.ts 的 gateHints 那一组，这里只钉渲染那一半）。
 *
 * 【变异臂】
 *  · M1 frames.ts 把 STATUTE_UNVERIFIED 映射改回 null      ⇒ ①② 全红
 *  · M2 GateHintLine 不渲染 frame.message（写死一句话）    ⇒ ① 红
 *  · M3 chip 的 onClick 改成不带参数 / 传别的串            ⇒ ② 红
 *  · M4 Messages 不把 onSuggest 传下来                     ⇒ ②（Workbench 接线那条）红
 */
import type { ReactElement, ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NoticeCode, NoticeFrame } from '../../_stream/frames';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const { GateHintLine } = await import('../StreamParts');

function frame(code: NoticeCode, message: string, suggest?: string): NoticeFrame {
  return { type: 'notice', code, message, ...(suggest === undefined ? {} : { suggest }) };
}

/** 剥标签，只留用户真读到的字 */
function visible(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * 在返回的元素树里找那枚 chip 的 onClick。
 *
 * 【为什么不用 DOM 点】本仓 vitest 跑在 node 环境（vitest.config.ts），没有浏览器。
 * 直接取处理函数验的是同一件事：**点下去到底把哪句话发出去了**。
 */
function findClick(node: ReactNode): ((e?: unknown) => void) | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findClick(child as ReactNode);
        if (hit) return hit;
      }
    }
    return null;
  }
  const props = (node as ReactElement).props as { onClick?: () => void; children?: ReactNode };
  if (typeof props.onClick === 'function') return props.onClick;
  return findClick(props.children ?? null);
}

const CASES: { code: NoticeCode; message: string; suggest: string }[] = [
  {
    code: 'CITATION_BLOCKED',
    message: '我引的案号（2023）京0105民初88888号在本轮检索里没有原文，已经去掉。',
    suggest: '找这个案例',
  },
  {
    code: 'STATUTE_UNVERIFIED',
    message: '本轮有 1 处条号不在这一轮取到的原文里，已标注【条号待核验】。',
    suggest: '查一下这条',
  },
  {
    code: 'VALUE_UNSOURCED',
    message: '本轮有 1 处数字既不是这一轮算出来的、也不在来源卡里。',
    suggest: '帮我算一下',
  },
];

describe('三道闸各一条：出路句真的上了屏', () => {
  it.each(CASES)('$code：可见文本就是后端的 message（前端不自己写一句顶替）', ({ code, message, suggest }) => {
    const html = renderToStaticMarkup(<GateHintLine frame={frame(code, message, suggest)} />);
    expect(visible(html)).toContain(message);
  });

  it.each(CASES)('$code：chip 的文字是后端给的 suggest', ({ code, message, suggest }) => {
    const html = renderToStaticMarkup(<GateHintLine frame={frame(code, message, suggest)} onSuggest={() => {}} />);
    expect(visible(html)).toContain(suggest);
  });

  it.each(CASES)('$code：点 chip = 以 suggest 原文发出一轮', ({ code, message, suggest }) => {
    const sent: string[] = [];
    const tree = GateHintLine({ frame: frame(code, message, suggest), onSuggest: (t) => sent.push(t) });
    const click = findClick(tree);
    expect(click, 'chip 上没有 onClick——它成了一段不能点的字').toBeTruthy();
    click!();
    expect(sent).toEqual([suggest]);
  });
});

describe('该不出现的时候不出现', () => {
  it('没有 suggest 就整条不画（⑦ 的出路已经逐字写在正文的替换句里，再顶一行是说两遍）', () => {
    expect(renderToStaticMarkup(<GateHintLine frame={frame('CITATION_BLOCKED', '检出 2 处伪逐字引用。')} />)).toBe('');
  });

  it('没有 onSuggest（流式途中）只出字不出按钮：这一轮还在答，点下去只会撞上另一道门', () => {
    const html = renderToStaticMarkup(<GateHintLine frame={frame('STATUTE_UNVERIFIED', '出路在这里。', '查一下这条')} />);
    expect(visible(html)).toContain('出路在这里。');
    expect(html).not.toContain('<button');
  });

  it('不用警报色：这些标记是「这一处别照抄」，不是错误提示', () => {
    const html = renderToStaticMarkup(
      <GateHintLine frame={frame('VALUE_UNSOURCED', '这个数没有来源。', '帮我算一下')} onSuggest={() => {}} />,
    );
    expect(html).not.toMatch(/text-(danger|destructive|red)/);
  });
});

/**
 * 接线那一半：组件写对了不等于它被调用了（本仓真实发生过一次「登记齐全、单测齐全、
 * 唯独没接线」，见 gate-chain.test.ts 第五节）。这两条按源码钉住两处传递。
 */
describe('接线', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('Messages 把 gateHints 的产物画成 GateHintLine（删掉 → 出路句又回到"生成过、没人读"）', () => {
    const src = read('../Messages.tsx');
    expect(src).toContain('gateHints(');
    expect(src).toContain('<GateHintLine');
  });

  it('Workbench 把 send 接到 onSuggest 上（不接 → chip 成了一枚点不动的按钮）', () => {
    const src = read('../Workbench.tsx');
    expect(src.match(/onSuggest=\{send\}/g)?.length, '历史消息与流式中那条都要接').toBe(2);
  });
});
