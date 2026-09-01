/**
 * 文书页的三条岔路：**取数中 / 没取到 / 确实没有**。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 「没取到」和「确实一份都没有」在屏幕上都是一片什么都没有的白。
 * RealDrafts / RealDraftView 里那句 `catch { setError(...) }` 是唯一把两者分开的东西——
 * 把它改成 `setDrafts([])`，页面会对一个名下确实有文书的人说「还没有文书」，
 * 而**整套 3427 条判据全绿**：取数在 useEffect 里，SSR 跑不到 effect，
 * 上一组（docs-drafts-real-data）验的全是「传进来什么就画什么」的那两层画法。
 * 同理，把落定后的 `drafts={drafts}` 换成 `drafts={[]}`（取回了却不画）也一样全绿。
 *
 * 所以这组必须**把 effect 推过去**。本仓 vitest 跑 node 环境、没有 DOM，
 * 装不了 react-dom/client，于是照同仓 settings/preferences-discreet-confirm 的老办法：
 * 把组件当普通函数推帧，只替掉 React 的状态层，**判定与接线仍是组件里真的那一份**。
 * 区别是那份只取元素树上的 props，这里还要把落定的那一帧交回真 React 渲染成 HTML——
 * 因此台架只在"推帧"期间接管三个 hook，`renderToStaticMarkup` 期间一律还给真 React。
 *
 * 【量具自证】台架若没真把 effect 推过去，落定帧仍是骨架，所有 not.toContain 会**空过**。
 * 所以每条判据都先断言那一屏该出现的正文（重试 / 文书标题 / 空态原话），
 * 再加一条「首帧是骨架、落定帧不是」把台架本身钉住。
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

/** 接口替身：`fails` 打开就抛，否则回 `rows` 里预置的行（形状照后端 DraftRow） */
const bus: { fails: boolean; rows: unknown[]; calls: string[] } = { fails: false, rows: [], calls: [] };
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    bus.calls.push(path);
    return bus.fails
      ? Promise.reject(new Error('网络没连上'))
      : Promise.resolve({ drafts: bus.rows });
  },
  humanError: (err: unknown) => (err instanceof Error ? `${err.message}。` : '出错了。'),
}));

/* ── hooks 台架 ─────────────────────────────────────────────
   on=true（推帧中）：useState 读写自己的槽位、useEffect 只登记不执行、useCallback 直通。
   on=false（交给 renderToStaticMarkup 渲染子树时）：三个 hook 原样转发给真 React，
   于是 Button / EmptyState / NeutralLabel 这些子组件照常工作。 */
const harness = {
  on: false,
  cursor: 0,
  slots: [] as Array<{ value: unknown }>,
  effects: [] as Array<() => unknown>,
};

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';
  return {
    ...real,
    useState: (init?: unknown) => {
      if (!harness.on) return real.useState(init as never);
      const i = harness.cursor++;
      harness.slots[i] ??= { value: isFn(init) ? (init as () => unknown)() : init };
      const slot = harness.slots[i];
      return [
        slot.value,
        (next: unknown) => {
          slot.value = isFn(next) ? (next as (prev: unknown) => unknown)(slot.value) : next;
        },
      ];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      if (!harness.on) return real.useEffect(fn as never, deps as never);
      harness.effects.push(fn);
    },
    useCallback: (fn: unknown, deps?: unknown[]) =>
      harness.on ? fn : real.useCallback(fn as never, deps as never),
  };
});

const { RealDrafts } = await import('../RealDrafts');
const { RealDraftView } = await import('../RealDraftView');

const ssr = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/** 一个真实案件的文书行，字段名逐字照后端行（lib/db/agent 的 DraftRow） */
function realDraftRows() {
  return [
    {
      id: 7,
      case_id: 9,
      kind: '异议函',
      title: '《解除劳动合同通知书》异议函',
      content: '朗华智联数据服务有限公司：\n本人不认可解除理由……',
      version: 2,
      status: 'draft',
      created_at: '2026-08-20T10:00:00+08:00',
      updated_at: '2026-08-21T11:30:00+08:00',
    },
    {
      id: 5,
      case_id: 9,
      kind: '证据清单',
      title: '证据清单（第一批）',
      content: '一、劳动合同一份……',
      version: 1,
      status: 'draft',
      created_at: '2026-08-18T09:00:00+08:00',
      updated_at: '2026-08-18T09:00:00+08:00',
    },
  ];
}

/** 推一帧：只在这期间接管 hook */
function frame<P>(Comp: (props: P) => ReactNode, props: P): ReactNode {
  harness.on = true;
  harness.cursor = 0;
  harness.effects.length = 0;
  try {
    return Comp(props);
  } finally {
    harness.on = false;
  }
}

/** 首帧 → 跑 effect → 等 promise 落定 → 再推一帧。回**落定后**那一屏。 */
async function settled<P>(Comp: (props: P) => ReactNode, props: P): Promise<ReactNode> {
  harness.slots.length = 0;
  frame(Comp, props);
  const queued = [...harness.effects];
  expect(queued.length, '组件没有登记任何 effect：台架接错了 hook').toBeGreaterThan(0);
  for (const run of queued) run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return frame(Comp, props);
}

const SKELETON = 'data-slot="skeleton"';

beforeEach(() => {
  bus.fails = false;
  bus.rows = realDraftRows();
  bus.calls.length = 0;
});

/* ── 〇、台架自证：effect 确实被推过去了 ───────────────────────── */

describe('台架', () => {
  /**
   * 没有这一条，下面每一句 `not.toContain` 都可能只是因为落定帧根本没画出来。
   * 首帧必须是骨架（取数中），落定帧必须不是——这正是 effect 跑没跑过的分界。
   */
  it('首帧是骨架，落定帧不是（否则下面全是空过）', async () => {
    const first = ssr(frame(RealDrafts, { caseId: '1' }));
    expect(first).toContain(SKELETON);
    expect(ssr(await settled(RealDrafts, { caseId: '1' }))).not.toContain(SKELETON);
    expect(bus.calls).toEqual(['/cases/1/drafts']);
  });
});

/* ── 一、RealDrafts：取不到 ≠ 没有 ─────────────────────────── */

describe('RealDrafts', () => {
  /**
   * 变异臂（N1）：把 `catch { setError(humanError(err)) }` 换成 `setDrafts([])`，这条会红——
   * 一个名下确实有文书的人，会读到「还没有文书」。这句话是假的，而屏幕上看不出任何异样。
   */
  it('接口抛错 ⇒ 说清没取出来 + 给重试，绝不说「还没有文书」', async () => {
    bus.fails = true;
    const html = ssr(await settled(RealDrafts, { caseId: '1' }));
    expect(text(html)).toContain('这一页没取出来');
    expect(text(html)).toContain('你的文书都还在');
    expect(text(html)).toContain('重试');
    expect(text(html)).not.toContain('还没有文书');
  });

  /**
   * 变异臂（N9）：把落定分支的 `drafts={drafts}` 换成 `drafts={[]}`，这条会红——
   * 取回来了却不画，是用另一种方式对用户说「你没有文书」。
   */
  it('取回两份 ⇒ 两份都画出来，不落到空态', async () => {
    const html = ssr(await settled(RealDrafts, { caseId: '1' }));
    expect(text(html)).toContain('《解除劳动合同通知书》异议函');
    expect(text(html)).toContain('证据清单（第一批）');
    expect(text(html)).not.toContain('还没有文书');
    expect(text(html)).not.toContain('重试');
  });

  /** 正对照：确实一份都没有的时候，才轮到空态说话——否则上面两条可能只是空态坏了 */
  it('接口回空数组 ⇒ 这时才是「还没有文书」，且不摆重试', async () => {
    bus.rows = [];
    const html = ssr(await settled(RealDrafts, { caseId: '1' }));
    expect(text(html)).toContain('还没有文书');
    expect(text(html)).not.toContain('重试');
    expect(html).toContain('href="/case/1/ask"');
  });
});

/* ── 二、RealDraftView：取不到 ≠ 这份不在 ──────────────────── */

describe('RealDraftView', () => {
  /**
   * 变异臂（N2）：同一处 catch 换成 `setDrafts([])`，这条会红——
   * findDraft 挑不到，页面会说「这份文书不在这个案件里」。
   * 那是一句关于**归属**的断言（这链接是别人的 / 是旧的），而事实只是这次没读到。
   */
  it('接口抛错 ⇒ 说清这份没取出来 + 给重试，不说「不在这个案件里」', async () => {
    bus.fails = true;
    const html = ssr(await settled(RealDraftView, { caseId: '1', draftId: '7' }));
    expect(text(html)).toContain('这份文书没取出来');
    expect(text(html)).toContain('它还在你的档案里');
    expect(text(html)).toContain('重试');
    expect(text(html)).not.toContain('这份文书不在这个案件里');
  });

  it('取回后按 id 画的是这一份的正文', async () => {
    const html = ssr(await settled(RealDraftView, { caseId: '1', draftId: '5' }));
    expect(text(html)).toContain('证据清单（第一批）');
    expect(text(html)).toContain('一、劳动合同一份');
    expect(text(html)).not.toContain('重试');
  });

  /** 正对照：真的挑不到那一份时，才说「不在这个案件里」 */
  it('这个案件里确实没有这个 id ⇒ 才说「不在这个案件里」', async () => {
    const html = ssr(await settled(RealDraftView, { caseId: '1', draftId: 'dr_1' }));
    expect(text(html)).toContain('这份文书不在这个案件里');
    expect(text(html)).not.toContain('重试');
  });
});
