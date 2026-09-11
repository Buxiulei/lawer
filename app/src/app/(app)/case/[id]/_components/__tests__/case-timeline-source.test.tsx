/**
 * 卷宗栏时间线**这一屏的数据从哪儿来**：演示案件走那套演示数据（零请求），
 * 真实案件现去取接口。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 复审变异实测：把取数那一步的 `if (demo)` 改成恒真（真实案件也走演示数据、一次请求都不发），
 * 全量判据**全绿**——渲染面那组喂的是现成的事件数组，根本不问这些行是从哪儿来的；
 * 而演示值与真值在屏幕上长得一样，肉眼也分不出。
 * 于是岔口被搬进 timelineData 的两个纯函数（initialTimeline / loadTimeline），
 * 本组拿一个**会计数的 apiFetch 桩**把它数出来。
 *
 * 【量具边界】本仓没有 jsdom，组件的 effect 不会自己跑。照同仓 workbench-history 的老办法：
 * 把组件当普通函数推帧，只替掉 React 的状态层，**判定与接线仍是 CaseTimeline 里真的那一份**。
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 接口替身：记下每一次调用的路径。**这就是本组的量具。** */
const bus = vi.hoisted(() => ({ calls: [] as string[], rows: [] as unknown[], fails: false }));
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    bus.calls.push(path);
    return bus.fails
      ? Promise.reject(new Error('网络没连上'))
      : Promise.resolve({ timeline: bus.rows });
  },
  humanError: (err: unknown) => (err instanceof Error ? `${err.message}。` : '出错了。'),
}));
vi.mock('@/app/_ui/caseDomain', () => ({ useCaseDomain: () => '', useMyDomain: () => '' }));

/* ── hooks 台架 ───────────────────────────────────────────
   on=true（推帧中）：三个 hook 读写自己的槽位，useEffect 只登记不执行。
   on=false：原样转发给真 React。 */
const harness = {
  on: false,
  cursor: 0,
  slots: [] as Array<{ value: unknown }>,
  effects: [] as Array<() => unknown>,
};

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';
  const slot = (init: unknown) => {
    const i = harness.cursor++;
    harness.slots[i] ??= { value: isFn(init) ? (init as () => unknown)() : init };
    return harness.slots[i];
  };
  return {
    ...real,
    useState: (init?: unknown) => {
      if (!harness.on) return real.useState(init as never);
      const s = slot(init);
      return [
        s.value,
        (next: unknown) => {
          s.value = isFn(next) ? (next as (prev: unknown) => unknown)(s.value) : next;
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

const { CaseTimeline } = await import('../CaseTimeline');
const { demoEvents, initialTimeline, loadTimeline } = await import('../timelineData');

const CASE = '7';
const TIMELINE_PATH = `/cases/${CASE}?timeline_limit=200`;

/** 推一帧：只在这期间接管 hook */
function frame(caseId: string, demo: boolean): ReactNode {
  harness.on = true;
  harness.cursor = 0;
  harness.effects.length = 0;
  try {
    return CaseTimeline({ caseId, demo }) as ReactNode;
  } finally {
    harness.on = false;
  }
}

/** 首帧 → 跑 effect → 等 promise 落定 → 再推一帧。回**落定后**那一屏。 */
async function settled(caseId: string, demo: boolean): Promise<ReactNode> {
  harness.slots.length = 0;
  frame(caseId, demo);
  expect(harness.effects.length, '组件没有登记任何 effect：台架接错了 hook').toBeGreaterThan(0);
  for (const run of [...harness.effects]) run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return frame(caseId, demo);
}

/** 这一帧投给渲染面的那批事件（CaseTimeline 只把它交给 TimelineSection，不自己画） */
function eventsOf(node: ReactNode): { length: number; titles: string[] } | null {
  const found: { length: number; titles: string[] }[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    const name = typeof el.type === 'function' ? (el.type as { name?: string }).name : undefined;
    if (name === 'TimelineSection') {
      const rows = el.props?.events as { title: string }[] | null;
      found.push(rows === null ? { length: -1, titles: [] } : { length: rows.length, titles: rows.map((r) => r.title) });
    }
    walk(el.props?.children);
  };
  walk(node);
  return found[0] ?? null;
}

beforeEach(() => {
  bus.calls.length = 0;
  bus.fails = false;
  bus.rows = [];
  harness.slots.length = 0;
});

describe('台架自证', () => {
  it('推得出渲染面，且首帧与落定帧确实不是同一份（否则下面全是空过）', async () => {
    bus.rows = [
      {
        id: 1,
        happened_at: '2026-09-02T10:00:00+08:00',
        kind: '公司动作',
        title: '真实案件的一条',
        detail: null,
        source_tier: '自述',
        event_type: null,
      },
    ];
    expect(eventsOf(frame(CASE, false))?.length, '首帧该是"还在读"（null）').toBe(-1);
    expect(eventsOf(await settled(CASE, false))?.titles).toEqual(['真实案件的一条']);
  });
});

describe('演示 / 真实这道岔口', () => {
  it('🔴 真实案件：effect 跑完，恰好发了一次时间线请求（变异：岔口改恒真走 demo → 零请求 → 红）', async () => {
    await settled(CASE, false);
    expect(bus.calls).toEqual([TIMELINE_PATH]);
  });

  it('🔴 演示案件：一次请求都不发，屏幕上摆的是那套演示数据', async () => {
    const out = await settled('demo', true);
    expect(bus.calls, '演示案件没有 cases 行，去请求只会换回一条 404').toEqual([]);
    expect(eventsOf(out)?.titles).toEqual(demoEvents().map((e) => e.title));
  });

  it('演示案件首帧就有那二十条，不先闪一帧骨架', () => {
    expect(eventsOf(frame('demo', true))?.length).toBe(demoEvents().length);
  });

  it('🔴 真实案件拿不到时间线 ⇒ 记下失败，**不拿演示数据顶上**', async () => {
    bus.fails = true;
    const out = await settled(CASE, false);
    expect(bus.calls).toEqual([TIMELINE_PATH]);
    expect(eventsOf(out)?.length, '失败时仍是"还在读/没有"，不是二十条演示事件').not.toBe(
      demoEvents().length,
    );
  });
});

describe('岔口那两个纯函数（判据直接对着它们，不经组件）', () => {
  it('🔴 loadTimeline(demo=false) 必定调接口；(demo=true) 一次都不调', async () => {
    await loadTimeline(CASE, false);
    expect(bus.calls).toEqual([TIMELINE_PATH]);

    bus.calls.length = 0;
    expect(await loadTimeline('demo', true)).toEqual(demoEvents());
    expect(bus.calls).toEqual([]);
  });

  it('initialTimeline：演示案件同步就有，真实案件是 null＝还在读', () => {
    expect(initialTimeline(true)).toEqual(demoEvents());
    expect(initialTimeline(false)).toBeNull();
    expect(bus.calls, '开屏那一刻不该发请求：取数是 effect 的事').toEqual([]);
  });
});
