/**
 * 路由过渡与流式光标的**非动效判据**守卫。
 *
 * 动效 v1 原则 5：**每一处动效传达的东西，静止时也必须能读出来**。
 * 这一条同时就是 prefers-reduced-motion 的降级保证——
 * 减弱动效时动画全被压掉，剩下的那份判据必须仍然在标记里。
 * 所以这里断言的是**标记**（属性、色 class），不是运行时动没动。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/case/demo' }));

import { CaretMark } from '@/app/(app)/case/[id]/_components/Messages';
import { RouteTransition, transitionKind } from '../RouteTransition';

describe('transitionKind', () => {
  it('首次挂载不播入场——硬加载时内容已经在那了，再淡一次只是拖慢首屏', () => {
    expect(transitionKind(null, '/case/demo')).toBe('none');
  });

  /*
   * 【这一条是本组的核心】驾驶舱在路径上**恰好是另外三栏的父路径**
   * （`/case/demo` vs `/case/demo/evidence`）。只看前缀就会把「驾驶舱 → 证据」
   * 判成下钻，于是四个同级 Tab 之间冒出一个不存在的层级。
   */
  it('同级四 Tab 之间是交叉淡入，驾驶舱→证据**不算下钻**', () => {
    expect(transitionKind('/case/demo', '/case/demo/evidence')).toBe('cross');
    expect(transitionKind('/case/demo', '/case/demo/ask')).toBe('cross');
    expect(transitionKind('/case/demo/evidence', '/case/demo/docs')).toBe('cross');
    expect(transitionKind('/case/demo/docs', '/case/demo')).toBe('cross');
  });

  it('两层起才是下钻（列表 → 详情）；返回不是下钻', () => {
    expect(transitionKind('/case/demo/evidence', '/case/demo/evidence/e_1')).toBe('rise');
    expect(transitionKind('/case/demo/drafts', '/case/demo/drafts/d_1')).toBe('rise');
    expect(transitionKind('/case/demo/evidence/e_1', '/case/demo/evidence')).toBe('cross');
  });

  it('跨案件不算下钻（同一层的两个案件之间没有前后关系）', () => {
    expect(transitionKind('/case/demo', '/case/other/evidence')).toBe('cross');
  });

  it('根路径不会把所有页面都当成下钻（`/` + `/x` 的拼接容易出这个 bug）', () => {
    expect(transitionKind('/', '/case/demo')).toBe('rise');
    expect(transitionKind('/case', '/casebook')).toBe('cross');
    expect(transitionKind('/account', '/settings')).toBe('cross');
  });
});

describe('RouteTransition 渲染', () => {
  it('首屏那一帧不带任何入场属性值，孩子原样在里面', () => {
    const html = renderToStaticMarkup(
      <RouteTransition>
        <p>现在做什么</p>
      </RouteTransition>,
    );
    expect(html).toContain('现在做什么'); // 正对照
    expect(html).toContain('data-route-anim="none"');
  });
});

describe('流式光标两态', () => {
  const live = renderToStaticMarkup(<CaretMark stalled={false} />);
  const stalled = renderToStaticMarkup(<CaretMark stalled />);

  it('两态在标记上确实不同（正对照）', () => {
    expect(live).not.toBe(stalled);
    expect(live).toContain('data-caret="live"');
    expect(stalled).toContain('data-caret="stalled"');
  });

  /*
   * 【这条是原则 5 的落地】减弱动效时 caret-blink / caret-breath 两条 keyframes
   * 都会被全局规则压掉。如果两态只差在动画上，那时候「正在吐字」和「卡住了」
   * 又会变回长得一模一样——那正是这个工单要修的毛病本身。
   * 所以颜色必须也分开：动画没了，颜色还在。
   */
  it('**颜色也分两档**，减弱动效时静止的一帧仍然分得出正在吐字与卡住了', () => {
    expect(live).toContain('bg-primary');
    expect(live).not.toContain('bg-ink-2');
    expect(stalled).toContain('bg-ink-2');
    expect(stalled).not.toContain('bg-primary');
  });
});
