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
 *  · B10 落定时不把 servedModel / modelMismatch 传给消息 ⇒ 「实际型号进消息」那条红
 *  · M-C6 失败轮那一支删掉（照 AssistantMessage 画）⇒ 「失败轮画成横幅」那组红
 *  · M-C7 重试按钮收窄成只给最后一条（加回 `i === messages.length - 1`）⇒ 「不是最后一条也给重试」红
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
/** 落定回调的接住处：本轮流走完之后 Workbench 拿它把新消息追进列表。
 *  `retried` 记下「点了历史里那条失败轮的重试」时传出去的 id。 */
const chat: { settle: (turn: unknown) => void; retried: string[] } = { settle: () => {}, retried: [] };
vi.mock('../../_stream/useChatStream', () => ({
  useChatStream: ({ onSettled }: { onSettled: (turn: unknown) => void }) => {
    chat.settle = onSettled;
    return {
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
      retryFailed: (id: string) => chat.retried.push(id),
      stop: () => {},
    };
  },
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
      failed_code: null,
    },
    {
      id: 42,
      role: 'assistant',
      content: '先别签任何文件。把《解除劳动合同通知书》拍照留存。',
      created_at: '2026-08-20T10:00:12+08:00',
      model: 'claude-opus-5',
      served_model: 'claude-sonnet-5',
      served_mismatch: true,
      failed_code: null,
    },
  ];
}

/** 一条失败轮：模型连不上那一轮落库的样子（content 是三段式失败文案，不是回答） */
const FAILED_ROW = {
  id: 43,
  role: 'assistant',
  content: '这一轮没能生成回答：模型服务这会儿连不上。稍等一下点「重试」。',
  created_at: '2026-08-20T10:00:30+08:00',
  model: null,
  served_model: null,
  served_mismatch: false,
  failed_code: 'AGENT_FAILED',
};

/* ── 元素树探针：不经 React 渲染（Workbench 底下挂着 Radix 弹层，渲染要 DOM）──
   只沿 children 与那几个"内容型" prop 往下走，收组件名与可见文字。 */
const TEXT_PROPS = ['children', 'title', 'description', 'action'] as const;

/** 消息组件收到的那个数据对象（正文之外还带型号两件套，落款就是照它画的） */
interface ProbedMessage {
  content?: unknown;
  model?: unknown;
  servedModel?: unknown;
  modelMismatch?: unknown;
}

function walk(
  node: unknown,
  types: string[],
  texts: string[],
  messages: ProbedMessage[],
): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, types, texts, messages);
    return;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props && !el.type) return;
  const t = el.type as { name?: string; displayName?: string } | string;
  const typeName = typeof t === 'string' ? t : (t?.displayName ?? t?.name ?? '?');
  types.push(typeName);
  // 失败轮画的是 StreamErrorCard，它的内容在 `error` 这个数据对象里（不是 ReactNode），
  // 且「给不给重试」体现为 onRetry 在不在——两样都不走 children，得单独取。
  if (typeName === 'StreamErrorCard') {
    const err = el.props?.error as { code?: unknown; message?: unknown } | undefined;
    errorCards.push({
      code: err?.code,
      message: err?.message,
      retryable: typeof el.props?.onRetry === 'function',
      onRetry: el.props?.onRetry as (() => void) | undefined,
    });
  }
  // 消息组件把正文放在 message 这个**数据对象**里（不是 ReactNode），单独取一下：
  // 少了它，"两条都画出来"那条会在空字符串上断言，静默空过。
  const message = el.props?.message as ProbedMessage | undefined;
  if (message) messages.push(message);
  if (typeof message?.content === 'string') texts.push(message.content);
  for (const key of TEXT_PROPS) walk(el.props?.[key], types, texts, messages);
}

/** 这一帧画出来的失败横幅（walk 的收集处，probe 每次开跑前清空） */
const errorCards: {
  code: unknown;
  message: unknown;
  retryable: boolean;
  onRetry?: () => void;
}[] = [];

function probe(node: ReactNode): {
  types: string[];
  text: string;
  messages: ProbedMessage[];
  errors: typeof errorCards;
} {
  const types: string[] = [];
  const texts: string[] = [];
  const messages: ProbedMessage[] = [];
  errorCards.length = 0;
  walk(node, types, texts, messages);
  return { types, text: texts.join(' '), messages, errors: [...errorCards] };
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
  chat.retried.length = 0;
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

/* ── 三、本轮落定：型号两件套跟着消息一起进列表 ────────────────
   收帧那一层把「实际服务的型号」收进了 SettledTurn（见 _stream 那组判据），
   但**从流里收到 ≠ 画到屏幕上**：中间还隔着 Workbench 落定时拼消息这一步。
   那一步漏传 servedModel/modelMismatch，页面照常出落款、照常是个好听的中文名，
   只不过它标的是 `meta.model`——我们**请求**的那个。用户按型号付费，读到的是假答案。 */

describe('落定的一轮把「实际型号」带进消息', () => {
  /** 本轮流走完时 useChatStream 交回来的东西，形状照 SettledTurn */
  function turn() {
    return {
      messageId: 'm_77',
      meta: {
        type: 'meta',
        thread_id: 'th_1',
        message_id: 'm_77',
        mode: '陪跑',
        intake_stage: null,
        task_class: 'critical',
        // 我们**请求**的那个
        model: 'claude-opus-5',
        degraded: false,
      },
      text: '这三句话不是一段话，是三个动作。',
      deterministicChars: 0,
      records: [],
      actions: [],
      drafts: [],
      notices: [],
      // 厂商**实际**派来的那个
      servedModel: 'claude-sonnet-5',
      servedMismatch: true,
      complete: true,
    };
  }

  /** 变异臂 B10：settle 里删掉 servedModel / modelMismatch 两行 ⇒ 这条红 */
  it('实际型号与「换过型号」一起进消息，请求值另存不覆盖', async () => {
    await settled(CASE);
    chat.settle(turn());

    const { messages } = probe(frame(CASE));
    const last = messages.at(-1);
    expect(last?.content).toBe('这三句话不是一段话，是三个动作。');
    expect(last?.servedModel).toBe('claude-sonnet-5');
    expect(last?.modelMismatch).toBe(true);
    expect(last?.model).toBe('claude-opus-5');
  });

  /** 新消息追在历史后面，不是把历史顶掉——两个来源必须合流成同一条列表 */
  it('历史两条 + 本轮一条 = 三条，顺序不乱', async () => {
    await settled(CASE);
    chat.settle(turn());

    const { messages, text } = probe(frame(CASE));
    expect(messages).toHaveLength(3);
    expect(text).toContain('我上周三被通知解除');
    expect(text).toContain('先别签任何文件');
    expect(text).toContain('这三句话不是一段话');
  });
});

/* ── 四、失败轮：刷新之后横幅与重试还在 ─────────────────────
   (naive-qa-2 F-203) 此前失败只是一张前端的卡：刷新后屏幕上只剩用户自己那句问题
   一句挨一句排着，没有任何"没答上"的痕迹，也没有重试入口。
   现在失败落成了一条 failed_code 行，页面必须把它画成横幅——而**不是画成一条回答**：
   那会让"模型这会儿连不上"读起来像律师在回答问题。 */

describe('失败轮回显：横幅 + 重试', () => {
  /** 变异臂 M-C6，整组的由头 */
  it('★历史里有失败轮 ⇒ 画成失败横幅（带错误码与失败文案），不画成回答', async () => {
    bus.rows = [...realRows(), FAILED_ROW];
    const { errors, messages } = probe(await settled(CASE));

    expect(errors, '失败轮没画成横幅').toHaveLength(1);
    expect(errors[0].code).toBe('AGENT_FAILED');
    expect(errors[0].message).toContain('没能生成回答');
    // 那一行不许同时又被当成一条回答画出去
    expect(messages.map((m) => m.content)).not.toContain(FAILED_ROW.content);
  });

  it('★横幅带重试，且点下去发的是那一行的库主键（不是展示 id）', async () => {
    bus.rows = [...realRows(), FAILED_ROW];
    const { errors } = probe(await settled(CASE));
    expect(errors[0].retryable, '失败轮没有重试入口 = 用户走进死胡同').toBe(true);
    errors[0].onRetry!();
    expect(chat.retried).toEqual(['43']);
  });

  /** 变异臂 M-C7：工单原文是「渲染出横幅与重试」，没限定哪一条——**每一条失败轮都给重试**。
   *  把它收窄成"只给最后一条"是一条尚未入台账的产品裁决，不由实现方在注释里裁定。 */
  it('★失败轮后面已经有新回答 ⇒ 横幅还在（如实记录），重试也照常给', async () => {
    bus.rows = [
      ...realRows(),
      FAILED_ROW,
      { ...realRows()[1], id: 44, content: '重试之后答上了。', created_at: '2026-08-20T10:01:00+08:00' },
    ];
    const { errors, text } = probe(await settled(CASE));
    expect(errors).toHaveLength(1);
    expect(errors[0].retryable, '不是最后一条就没了重试入口 = 那条失败轮永远重试不了').toBe(true);
    errors[0].onRetry!();
    expect(chat.retried).toEqual(['43']); // 重试指向那条失败行本身，不是末尾那条
    expect(text, '这一轮确实失败过，抹掉它就是改历史').toContain('重试之后答上了');
  });

  /** 反向对照：没有失败轮时一张横幅都不许出现 */
  it('全是正常轮 ⇒ 一张失败横幅都没有', async () => {
    const { errors } = probe(await settled(CASE));
    expect(errors).toEqual([]);
  });
});
