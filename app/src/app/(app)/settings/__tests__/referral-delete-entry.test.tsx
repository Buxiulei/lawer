/**
 * 设置页：**协议附一第 9 项「转介删除请求通道」在网页上真的点得到**（协议九.3
 *「转介一经发出即到达 NBDpsy；你可以要求 NBDpsy 删除该转介信息」）。
 *
 * 【这一组要拦的四种静默错法】
 *   · 这条通道只有 MCP 工具与 REST——**不接自带 agent 的人在网页上一个按钮都点不到**，
 *     而 referral_delete_request 的自测全绿（2026-09-07 复审）；
 *   · 点一下就发出去，没有确认那一步（撤回一次对外披露是不可逆的动作）；
 *   · 页面自己写一版「已经删掉了」——东西在对方手上，我们此刻只做到了"记下并待人工转达"；
 *   · 提过之后刷新一次按钮又冒出来，用户以为上次没提成，于是再提一遍。
 *
 * 本仓库 vitest 跑 node 环境、没有 DOM，所以把组件当普通函数调用、在返回的元素树上取
 * props 触发。只替掉 React 的状态层与 apiFetch，**判定与接线仍是组件里真的那一份**。
 */
import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown>;

/**
 * 多槽位 useState：按调用序给槽，每次渲染前把游标拨回 0。
 * 单槽版（"第一个 useState 说了算"）在这张卡上不成立——它有四个 state。
 */
const bus = {
  slots: [] as unknown[],
  idx: 0,
  effects: [] as (() => void)[],
};

const api = {
  calls: [] as { path: string; method: string; body?: unknown }[],
  reply: (async () => ({})) as (path: string, options: Props) => Promise<unknown>,
};

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    useState: (init: unknown) => {
      const i = bus.idx++;
      if (!(i in bus.slots)) {
        bus.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      }
      return [
        bus.slots[i],
        (u: unknown) => {
          bus.slots[i] = typeof u === 'function' ? (u as (p: unknown) => unknown)(bus.slots[i]) : u;
        },
      ];
    },
    useEffect: (fn: () => void) => {
      bus.effects.push(fn);
    },
    useCallback: (fn: unknown) => fn,
  };
});

vi.mock('@/app/_ui/api', () => ({
  apiFetch: (p: string, options: Props = {}) => {
    api.calls.push({ path: p, method: (options.method as string) ?? 'GET', body: options.body });
    return api.reply(p, options);
  },
  humanError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const { ReferralCard } = await import('../_components/ReferralCard');
const { REFERRAL_DELETE_PENDING_NOTE } = await import('@/lib/lifecycle/referral-delete');

// ───────────────────────────── 迷你渲染器 ─────────────────────────────

function walk(node: ReactNode, visit: (props: Props) => void): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) walk(child, visit);
    return;
  }
  if (!isValidElement(node)) return;
  const props = node.props as Props;
  visit(props);
  walk(props.children as ReactNode, visit);
  for (const key of ['description', 'title']) {
    if (isValidElement(props[key])) walk(props[key] as ReactNode, visit);
  }
}

function textOf(node: ReactNode): string {
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
    const props = n.props as Props;
    collect(props.children as ReactNode);
    // 'text' 是 ServerCopy 的入参：服务端下发的句子挂在那个 prop 上，不在 children 里
    for (const key of ['description', 'title', 'confirmLabel', 'text']) {
      collect(props[key] as ReactNode);
    }
  };
  collect(node);
  return parts.join(' ');
}

function buttons(tree: ReactNode, label: string): Props[] {
  const hits: Props[] = [];
  walk(tree, (props) => {
    if (typeof props.onClick !== 'function') return;
    if (textOf(props.children as ReactNode).trim() === label) hits.push(props);
  });
  return hits;
}

function findByProp(tree: ReactNode, key: string): Props | null {
  let hit: Props | null = null;
  walk(tree, (props) => {
    if (hit === null && key in props) hit = props;
  });
  return hit;
}

function render(): ReactNode {
  bus.idx = 0;
  bus.effects = [];
  const tree = ReferralCard() as ReactNode;
  for (const fn of bus.effects) fn();
  return tree;
}

async function settle(): Promise<ReactNode> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  bus.idx = 0;
  bus.effects = [];
  return ReferralCard() as ReactNode;
}

function backend(table: Record<string, unknown | ((body: unknown) => unknown)>) {
  api.reply = async (p, options) => {
    const key = `${(options.method as string) ?? 'GET'} ${p}`;
    if (!(key in table)) throw new Error(`判据没给这条路配回包：${key}`);
    const v = table[key];
    return typeof v === 'function' ? (v as (b: unknown) => unknown)(options.body) : v;
  };
}

const REFERRAL = {
  referral_id: 12,
  case_id: 7,
  status: 'sent',
  external_ref: 'NBD-0001',
  attempts: 1,
  last_error: null,
  created_at: '2026-09-01 10:00:00',
};

const BODY = {
  referrals: [REFERRAL],
  consent: { shared: [{ field: 'reason', label: '你为什么想找人聊聊' }], not_shared: ['公司名'] },
  delete_requests: [] as { request_id: number; referral_id: number | null; delivered: boolean; requested_at: string }[],
  delete_note: REFERRAL_DELETE_PENDING_NOTE,
};

beforeEach(() => {
  bus.slots = [];
  bus.idx = 0;
  bus.effects = [];
  api.calls = [];
});

describe('转介删除请求的网页入口', () => {
  it('每条转介都有「要求删除这条转介」的按钮（变异：把那个按钮删掉 → 本条红）', async () => {
    backend({ 'GET /referrals': BODY });
    render();
    const card = await settle();
    expect(buttons(card, '要求删除这条转介')).toHaveLength(1);
  });

  it('点一下先弹确认框、一条请求都不发（撤回一次对外披露是不可逆的）', async () => {
    backend({ 'GET /referrals': BODY });
    render();
    const card = await settle();

    api.calls = [];
    (buttons(card, '要求删除这条转介')[0].onClick as () => void)();
    expect(api.calls, '还没确认就把删除请求发出去了').toEqual([]);

    bus.idx = 0;
    const dialog = findByProp(ReferralCard() as ReactNode, 'confirmLabel')!;
    expect(dialog.open).toBe(true);
    // 后果那句话是服务端给的正本，页面不另写一份
    expect(textOf(dialog.description as ReactNode)).toBe(REFERRAL_DELETE_PENDING_NOTE);
  });

  it('确认之后 POST /referrals/{id}/delete-request（变异：改成 DELETE /referrals/{id} → 本条红）', async () => {
    backend({
      'GET /referrals': BODY,
      'POST /referrals/12/delete-request': { note: '已经记在我们这边。' },
    });
    render();
    const card = await settle();
    (buttons(card, '要求删除这条转介')[0].onClick as () => void)();

    bus.idx = 0;
    const dialog = findByProp(ReferralCard() as ReactNode, 'confirmLabel')!;
    api.calls = [];
    (dialog.onConfirm as () => void)();

    expect(api.calls).toEqual([
      { path: '/referrals/12/delete-request', method: 'POST', body: {} },
    ]);
  });

  it('提过之后不再给按钮，且说的是「尚未送达」不是「已删除」', async () => {
    backend({
      'GET /referrals': {
        ...BODY,
        delete_requests: [
          { request_id: 1, referral_id: 12, delivered: false, requested_at: '2026-09-02 00:00:00' },
        ],
      },
    });
    render();
    const card = await settle();

    expect(buttons(card, '要求删除这条转介'), '提过了还给按钮，用户会再提一遍').toHaveLength(0);
    const text = textOf(card);
    expect(text).toContain('尚未送达对方');
    expect(text, '页面说成「已删除」——那是一句我们此刻还证明不了的话').not.toContain('已删除');
  });

  it('别的转介照旧有按钮（提过的那一条不该把整张卡的入口关掉）', async () => {
    const another = { ...REFERRAL, referral_id: 13, external_ref: 'NBD-0002' };
    backend({
      'GET /referrals': {
        ...BODY,
        referrals: [REFERRAL, another],
        delete_requests: [
          { request_id: 1, referral_id: 12, delivered: false, requested_at: '2026-09-02 00:00:00' },
        ],
      },
    });
    render();
    const card = await settle();
    expect(buttons(card, '要求删除这条转介')).toHaveLength(1);
  });

  it('从没转介过时整张卡仍然不渲染（不给没转介过的人摆一个「删除转介」的按钮）', async () => {
    backend({ 'GET /referrals': { ...BODY, referrals: [] } });
    render();
    expect(await settle()).toBeNull();
  });
});
