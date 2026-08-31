'use client';

import { useEffect } from 'react';

/**
 * 引用桥（PC 工作台设计 §四「签名件」）。
 *
 * 一句话：**同一份东西在三栏里连起来**。
 *  - 停在对话里的一条法条依据上 → 卷宗栏「本案依据」里同条那一行亮（不滚动）；
 *  - 点击 / 键盘激活那条依据 → 查看器（第三栏）开出逐字原件并 scrollIntoView；
 *  - 反过来停在卷宗栏那一行上 → 对话里引用过它的**每一处**都亮
 *    （「这条依据我在哪引过」在此之前完全答不了）。
 *
 * 【为什么是文档级委托，不是每个块各自 useState】照 `_ui/veil.tsx` 的同一个理由：
 * 引用点会有几十上百个，每个各自订阅一次就是几十上百个订阅者，
 * 鼠标每划过一格就要 re-render 一片。这里全程只改 DOM 属性，React 不参与点亮。
 *
 * 【硬约束：hover 不许改布局】点亮只加底色和外扩 box-shadow（都不占位），
 * 绝不动 padding / border-width / font-size（样式见 globals.css 批B 段）。
 *
 * 【设备判定不进 render】设计红线①：`matchMedia` 只在副作用里读。
 * 问的是 `any-hover: hover`——一台接着鼠标、挂着外接屏的触摸屏笔记本
 * 主输入会被判成 coarse，用 `(hover:hover)` 会把它整台挡在外面、还不报错。
 * 纯触屏（手机 / 平板）是 `any-hover: none`，桥整个不装，移动端零回归的判据不受影响。
 *
 * 【桥做不出三栏就该砍】激活走 `onActivate` 回调交给宿主（Workbench）去开查看器，
 * 而不是在这里自己滚动对话——第三栏才是这座桥存在的理由。
 */

/** 引用方：对话里的一处引用（法条卡）。值是**空格分隔**的引用 id，一处可引多样。 */
export const CITE_ATTR = 'data-cite';
/** 被引方：卷宗栏里的那一行。值同样是空格分隔的 id。 */
export const CITE_TARGET_ATTR = 'data-cite-target';
/** 桥点亮时落在**两端**的标记。样式在 globals.css 批B 段。 */
export const CITE_LIT_ATTR = 'data-cite-lit';

const SELECTOR = `[${CITE_ATTR}],[${CITE_TARGET_ATTR}]`;

/**
 * 空格分隔的 id 串拆成数组。
 * 空串 / null / 纯空白一律回空数组——**不能回 ['']**，否则两个「没有引用」的元素
 * 会因为共有一个空串而互相点亮，看起来像桥连错了人。
 */
export function parseCiteIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * 两串 id 有没有交集——这是「谁连谁」的全部判据，**变异核就打在这里**。
 * 空集合自然不相交，不额外写 length===0 的分支：那条分支永远和这一行给同样的
 * 答案，变异测试也杀不掉它，属于看着谨慎的死代码。
 */
export function intersects(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

/**
 * 法条引用的 id。
 * **去掉全部空白**：同一个条号在正文里可能写成「第四十七条」也可能中间多一个空格
 * （「第 47 条」），留着空白既会被 parseCiteIds 拆成两半，也会让两处同一条法条对不上。
 */
export function lawCiteId(cite: string): string {
  return `law:${cite.replace(/\s+/g, '')}`;
}

/** 证据的 id。 */
export function evidenceCiteId(id: string): string {
  return `ev:${id}`;
}

/** 一个节点在桥上认的全部 id（自己是引用方还是被引方都算）。 */
function idsOf(el: Element): string[] {
  return [
    ...parseCiteIds(el.getAttribute(CITE_ATTR)),
    ...parseCiteIds(el.getAttribute(CITE_TARGET_ATTR)),
  ];
}

/** 减弱动效时不做平滑滚动（设计 §动效：引用桥在 reduced-motion 下保留底色、去过渡与平滑滚动）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface CitationBridgeOptions {
  /**
   * 激活一处引用（鼠标点击或键盘 Enter/Space——`<summary>` / `<button>` 都会
   * 把键盘激活合成为一次 click，所以只听 click 就同时收了两条路）。
   * 宿主拿到这处引用认的全部 id，去开查看器。
   */
  onActivate?: (ids: string[], anchor: Element) => void;
}

/**
 * 装上这座桥。整页只该装一次（挂在对话工作台 Workbench 上：它同时有对话侧的
 * 法条卡和 portal 进来的卷宗栏，两端都在它的 DOM 里）。
 */
export function useCitationBridge(options?: CitationBridgeOptions): void {
  const onActivate = options?.onActivate;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // 触屏没有 hover：装了也点不亮，还白白给每次触摸加一轮 querySelectorAll。
    if (!window.matchMedia('(any-hover: hover)').matches) return;

    let lit: Element[] = [];
    let hovered: Element | null = null;
    let focused: Element | null = null;

    const anchorOf = (node: EventTarget | null): Element | null =>
      node instanceof Element ? node.closest(SELECTOR) : null;

    /** 鼠标优先于焦点：手在哪儿，眼睛就在哪儿。 */
    const apply = () => {
      const anchor = hovered ?? focused;
      const ids = anchor ? idsOf(anchor) : [];

      for (const el of lit) el.removeAttribute(CITE_LIT_ATTR);
      lit = [];
      if (ids.length === 0) return;

      for (const el of document.querySelectorAll(SELECTOR)) {
        if (!intersects(idsOf(el), ids)) continue;
        el.setAttribute(CITE_LIT_ATTR, '');
        lit.push(el);
      }
    };

    const onOver = (e: PointerEvent) => {
      const next = anchorOf(e.target);
      if (next === hovered) return;
      hovered = next;
      apply();
    };

    // 鼠标从窗口整体离开时不会再发 pointerover，得单独收一次尾。
    const onLeave = () => {
      if (!hovered) return;
      hovered = null;
      apply();
    };

    const onFocusIn = (e: FocusEvent) => {
      const next = anchorOf(e.target);
      if (next === focused) return;
      focused = next;
      apply();
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!focused) return;
      // 焦点还在同一块里挪（summary → 块内链接）不算离开。
      const next = e.relatedTarget;
      if (next instanceof Node && focused.contains(next)) return;
      focused = null;
      apply();
    };

    const onClick = (e: MouseEvent) => {
      if (!onActivate) return;
      const anchor = anchorOf(e.target);
      if (!anchor) return;
      // **不 preventDefault**：法条卡是 <details>，点它要照常展开；
      // 我们只是顺手把原件也钉进查看器。
      onActivate(idsOf(anchor), anchor);
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerleave', onLeave, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('click', onClick, true);

    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerleave', onLeave, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick, true);
      for (const el of lit) el.removeAttribute(CITE_LIT_ATTR);
    };
  }, [onActivate]);
}

/**
 * 对话里引过的法条，按**第一次出现的顺序**汇总，附上「引用 N 处」。
 * 不排序也不去重后重排：读者对着对话往回找的时候，顺序对不上比少一条更难受。
 */
export function citedLaws(
  messages: readonly { lawRefs?: readonly { cite: string }[] }[],
): { cite: string; count: number }[] {
  const order: string[] = [];
  const count = new Map<string, number>();
  for (const m of messages) {
    for (const law of m.lawRefs ?? []) {
      if (!count.has(law.cite)) order.push(law.cite);
      count.set(law.cite, (count.get(law.cite) ?? 0) + 1);
    }
  }
  return order.map((cite) => ({ cite, count: count.get(cite) ?? 0 }));
}
