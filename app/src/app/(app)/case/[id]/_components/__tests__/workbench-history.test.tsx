/**
 * 打开对话页必须**先把聊过的话取回来**，取不到必须说出来。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 对话页此前从不取历史：库里 messages 表一条不少地存着（agent 每轮都落两行），
 * 但页面只往里追加**本次会话**新说的话。用户关掉网页再打开，屏幕上一片空白——
 * **页面看起来完全正常**：没有报错、输入框好好的，只是他讲过的两小时不见了。
 * 他会从头再讲一遍。那既是钱，也是又一次把被裁的经过复述一遍。
 *
 * 【为什么必须把 effect 推过去】取数在 useEffect 里，SSR 那一遍根本跑不到；
 * 只验"传进来什么就画什么"的判据，在「压根没去取」这个形态上**全绿**。
 * 所以照同仓 real-drafts-branches 的老办法：把组件当普通函数推帧，只替掉 React 的
 * 状态层，**判定与接线仍是 Workbench 里真的那一份**。
 *
 * 【变异臂】
 *  · C1 删掉 `useCaseHistory(...)` 这一句（回到"不取历史"）⇒ 「挂载即取」那条红
 *  · C2 把 failed 分支换成走正常那一屏（"没取到"画成"没聊过"）⇒ 「重试非空态」那条红
 *  · C3 取回来的历史不落进 messages（`if (history.messages)` 那句删掉）⇒ 「两条都画出来」红
 *  · C4 演示案件也去请求 ⇒ 「演示案件不请求」那条红
 */
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ── 替身：把 Workbench 周边那些需要 DOM / Provider 的东西挡掉 ──────────
   它们与本组要验的事（取不取历史、取不到怎么办）无关，留着只会把台架变成一台浏览器。 */
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('../../_workspace/CaseWorkspaceProvider', () => ({
  useCaseWorkspace: () => ({ openViewer: () => {}, viewer: null }),
  useDossierPortal: () => null,
  useViewerPortal: () => null,
}));
vi.mock('@/components/shell/casePanel', () => ({ useRegisterCasePanel: () => {} }));
vi.mock('../citations', () => ({
  lawCiteId: (cite: string) => cite,
  prefersReducedMotion: () => true,
  useCitationBridge: () => {},
}));
// 动效模块只替掉这两个读环境的 hook，其余原样留着：gsap 那条链在模块顶层就要用到它们
vi.mock('@/app/_ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/motion')>()),
  scrollBehavior: () => 'auto' as const,
  useReducedMotion: () => true,
}));
vi.mock('../../_stream/useChatStream', () => ({
  useChatStream: () => ({
    phase: 'idle',
    meta: null,
    text: '',
    deterministicChars: 0,
    records: [],
    actions: [],
    drafts: [],
    notices: [],
    error: null,
    waitBaseAt: null,
    busy: false,
    demoFallback: false,
    send: () => {},
    retry: () => {},
    stop: () => {},
  }),
}));

/** 登录态替身：默认已登录，否则页面走的是「去做首诊」那一屏，根本不到取历史这一步 */
const auth = { token: 'jwt-token' as string | null };
vi.mock('@/app/_ui/auth', () => ({
  readToken: () => auth.token,
  clearToken: () => {},
  TOKEN_STORAGE_KEY: 'k',
}));
vi.mock('../../_stream/httpTransport', () => ({
  readToken: () => auth.token,
  createHttpTransport: () => ({ kind: 'http', send: async function* () {} }),
  TOKEN_STORAGE_KEY: 'k',
}));

/** 接口替身：`fails` 打开就抛，否则回 `rows` 里预置的行（形状照后端 CaseMessageView） */
const bus: { fails: boolean; rows: unknown[]; calls: string[] } = {
  fails: false,
  rows: [],
  calls: [],
};
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    bus.calls.push(path);
    return bus.fails
      ? Promise.reject(new Error('网络没连上'))
      : Promise.resolve({ messages: bus.rows });
  },
  humanError: (err: unknown) => (err instanceof Error ? `${err.message}。` : '出错了。'),
}));

/* ── hooks 台架 ─────────────────────────────────────────────
   on=true（推帧中）：五个 hook 读写自己的槽位，useEffect 只登记不执行。
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
    useRef: (init?: unknown) => (harness.on ? slot({ current: init }).value : real.useRef(init as never)),
    useMemo: (fn: () => unknown, deps?: unknown[]) =>
      harness.on ? fn() : real.useMemo(fn as never, deps as never),
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      if (!harness.on) return real.useEffect(fn as never, deps as never);
      harness.effects.push(fn);
    },
    useCallback: (fn: unknown, deps?: unknown[]) =>
      harness.on ? fn : real.useCallback(fn as never, deps as never),
  };
});

const { Workbench } = await import('../Workbench');
const { demoCase } = await import('@/app/_mock/demo');

/** 一段真实案件的历史，字段名逐字照后端行（lib/cases 的 CaseMessageView） */
function realRows() {
  return [
    {
      id: 41,
      role: 'user',
      content: '我上周三被通知解除，公司说是优化。',
      created_at: '2026-08-20T10:00:00+08:00',
      model: null,
      served_model: null,
      served_mismatch: false,
    },
    {
      id: 42,
      role: 'assistant',
      content: '先别签任何文件。把《解除劳动合同通知书》拍照留存。',
      created_at: '2026-08-20T10:00:12+08:00',
      model: 'claude-opus-5',
      served_model: 'claude-sonnet-5',
      served_mismatch: true,
    },
  ];
}

/* ── 元素树探针：不经 React 渲染（Workbench 底下挂着 Radix 弹层，渲染要 DOM）──
   只沿 children 与那几个"内容型" prop 往下走，收组件名与可见文字。 */
const TEXT_PROPS = ['children', 'title', 'description', 'action'] as const;

function walk(node: unknown, types: string[], texts: string[]): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, types, texts);
    return;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props && !el.type) return;
  const t = el.type as { name?: string; displayName?: string } | string;
  types.push(typeof t === 'string' ? t : (t?.displayName ?? t?.name ?? '?'));
  // 消息组件把正文放在 message 这个**数据对象**里（不是 ReactNode），单独取一下：
  // 少了它，"两条都画出来"那条会在空字符串上断言，静默空过。
  const message = el.props?.message as { content?: unknown } | undefined;
  if (typeof message?.content === 'string') texts.push(message.content);
  for (const key of TEXT_PROPS) walk(el.props?.[key], types, texts);
}

function probe(node: ReactNode): { types: string[]; text: string } {
  const types: string[] = [];
  const texts: string[] = [];
  walk(node, types, texts);
  return { types, text: texts.join(' ') };
}

/** 推一帧：只在这期间接管 hook */
function frame(caseId: string): ReactNode {
  harness.on = true;
  harness.cursor = 0;
  harness.effects.length = 0;
  try {
    return Workbench({ caseId });
  } finally {
    harness.on = false;
  }
}

/** 首帧 → 跑 effect → 等 promise 落定 → 再推一帧。回**落定后**那一屏。 */
async function settled(caseId: string): Promise<ReactNode> {
  harness.slots.length = 0;
  frame(caseId);
  const queued = [...harness.effects];
  expect(queued.length, '组件没有登记任何 effect：台架接错了 hook').toBeGreaterThan(0);
  for (const run of queued) run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 再推一帧后可能有新 effect（历史落进 messages 那一条），跑掉它再定帧
  const second = frame(caseId);
  for (const run of [...harness.effects]) run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return harness.effects.length > 0 ? frame(caseId) : second;
}

const CASE = '9';

beforeEach(() => {
  auth.token = 'jwt-token';
  bus.fails = false;
  bus.rows = realRows();
  bus.calls.length = 0;
  harness.slots.length = 0;
});

/* ── 〇、台架自证 ─────────────────────────────────────────── */

describe('台架', () => {
  /**
   * 没有这一条，下面每一句断言都可能只是因为落定帧根本没画出来。
   * 首帧必须是骨架（取数中），落定帧必须不是——这正是 effect 跑没跑过的分界。
   */
  it('首帧是骨架，落定帧不是（否则下面全是空过）', async () => {
    expect(probe(frame(CASE)).types).toContain('SkeletonList');
    expect(probe(await settled(CASE)).types).not.toContain('SkeletonList');
  });
});

/* ── 一、挂载即取 ─────────────────────────────────────────── */

describe('挂载即取历史', () => {
  /** 变异臂 C1：删掉 Workbench 里那句 useCaseHistory ⇒ 这条红 */
  it('打开真实案件 ⇒ 立刻请求这个案件的历史对话', async () => {
    await settled(CASE);
    expect(bus.calls).toContain(`/cases/${CASE}/messages`);
  });

  /** 变异臂 C3：取回来了却不落进消息列表 ⇒ 这条红（"取了等于没取"） */
  it('取回两条 ⇒ 两条都画出来，且不落到「还没有对话记录」', async () => {
    const { text } = probe(await settled(CASE));
    expect(text).toContain('我上周三被通知解除');
    expect(text).toContain('先别签任何文件');
    expect(text).not.toContain('这个案件还没有对话记录');
  });

  /** 变异臂 C4：演示案件也去请求 ⇒ 这条红。演示剧本的消息不在库里，请求只会白跑一趟 404 */
  it('演示案件走演示剧本，一次请求都不发', async () => {
    await settled(demoCase.id);
    expect(bus.calls).toEqual([]);
  });

  /** 没登录时页面给的是「去做首诊」，不该再叠一张重试卡，也不该发请求 */
  it('未登录 ⇒ 不请求，且仍是「去做首诊」那一屏', async () => {
    auth.token = null;
    const { text } = probe(await settled(CASE));
    expect(bus.calls).toEqual([]);
    expect(text).toContain('这个案件还没有对话记录');
  });
});

/* ── 二、没取到 ≠ 没聊过 ──────────────────────────────────── */

describe('取不到时说清楚 + 给重试', () => {
  /**
   * 【变异臂 C2，整组的由头】把 failed 分支去掉、让它走正常那一屏，这条会红——
   * 一个刚聊完两小时的人会读到一片空白的对话页，以为记录没了。
   * 屏幕上看不出任何异样，这正是最难当场发现的那种坏法。
   */
  it('接口抛错 ⇒ 说清没读到 + 摆重试，绝不说「还没有对话记录」', async () => {
    bus.fails = true;
    const { text } = probe(await settled(CASE));
    expect(text).toContain('这次没读到你的对话记录');
    expect(text).toContain('你聊过的内容都还在');
    expect(text).toContain('重试');
    expect(text).not.toContain('这个案件还没有对话记录');
  });

  /** 失败那一屏不许画输入框：让人在"记录可能没保存上"的状态下继续说，是更坏的一步 */
  it('失败那一屏不出输入框', async () => {
    bus.fails = true;
    expect(probe(await settled(CASE)).types).not.toContain('Composer');
  });

  /** 正对照：确实一条都没聊过时，照常出输入框，不摆重试 */
  it('真的一条都没有 ⇒ 照常出输入框，不摆重试', async () => {
    bus.rows = [];
    const { types, text } = probe(await settled(CASE));
    expect(types).toContain('Composer');
    expect(text).not.toContain('重试');
  });
});
