/**
 * done 帧回显的**实际**型号必须原样落进 SettledTurn，不许被 meta 里那个「请求值」顶替。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 「这一轮谁答的」有两个值：`meta.model` 是我们**请求**的（开跑前就发了），
 * `done.served_model` 是厂商回显的**实际**服务的那个。中转按渠道分组路由，
 * 请求 opus 完全可能由 sonnet 返回，两者不是一回事。
 * 此前收帧这一段只有类型和渲染侧受判据看守：**真链路上 done 帧到底有没有被读进来**，
 * 一条判据都没有。收帧那三行删掉之后，页面照常出落款、照常写着一个好听的中文名——
 * 只是它标的是我们请求的那个型号，而用户按型号付费。**标错比不标更坏**。
 *
 * 【台架】不引 DOM：用 react-dom/server 推一帧把 hook 的返回值取出来（SSR 里
 * useReducer 的 dispatch 是 no-op，正是我们要的：只验 `turn` 这个累加对象），
 * 然后调它的 send()，让**真的收帧循环**跑完这串帧。传输层是替身，判定仍是 useChatStream 里那一份。
 *
 * 【变异臂】
 *  · B8  done 分支删掉 `turn.servedModel = frame.served_model ?? null` ⇒ 「实际落进来」那条红
 *  · B9  改成 `turn.servedModel = turn.meta?.model ?? null`（拿请求值冒充实际值）⇒ 同一条红
 *  · B11 删掉 `turn.servedMismatch = frame.served_mismatch === true`（恒 false）⇒ 「换过型号」那条红
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamFrame } from '../frames';
import type { SettledTurn } from '../useChatStream';

/** 传输替身：把预置好的一串帧原样吐出来，收帧那一段仍是真的 */
const script: { frames: StreamFrame[] } = { frames: [] };

vi.mock('../httpTransport', () => ({
  createHttpTransport: () => ({
    kind: 'http' as const,
    async *send() {
      for (const frame of script.frames) yield frame;
    },
  }),
  readToken: () => 'jwt-token',
  TOKEN_STORAGE_KEY: 'k',
}));

const { useChatStream } = await import('../useChatStream');
const { servedModelLabel } = await import('../frames');

const meta: StreamFrame = {
  type: 'meta',
  thread_id: 'th_1',
  message_id: 'm_77',
  mode: '陪跑',
  intake_stage: null,
  task_class: 'critical',
  // 我们**请求**的那个
  model: 'claude-opus-5',
  degraded: false,
};

const delta: StreamFrame = { type: 'delta', text: '先别签任何文件。' };

/** 跑一轮：推一帧取到 send，喂完帧，等 onSettled 回调 */
async function runTurn(frames: StreamFrame[]): Promise<SettledTurn> {
  script.frames = frames;
  const settled: SettledTurn[] = [];
  let api: ReturnType<typeof useChatStream> | null = null;

  function Probe() {
    api = useChatStream({ caseId: '9', onSettled: (turn) => settled.push(turn) });
    return null;
  }

  renderToStaticMarkup(<Probe />);
  expect(api, '台架没取到 hook 返回值').not.toBeNull();
  api!.send('HR 让我今天签字。');

  for (let i = 0; i < 50 && settled.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(settled.length, '这一轮没有落定：台架接错了传输层').toBe(1);
  return settled[0];
}

beforeEach(() => {
  script.frames = [];
});

describe('done 帧的型号三件套落进 SettledTurn', () => {
  /** 变异臂 B8 / B9：整组的由头 */
  it('厂商换了型号 ⇒ 落定的是**实际**那个，请求值原样留在 meta 里', async () => {
    const turn = await runTurn([
      meta,
      delta,
      {
        type: 'done',
        message_id: 'm_77',
        finish_reason: 'stop',
        model: 'claude-opus-5',
        served_model: 'claude-sonnet-5',
        served_mismatch: true,
      },
    ]);

    expect(turn.servedModel).toBe('claude-sonnet-5');
    // 两个字段是两件事：请求值不许被实际值抹掉，实际值更不许被请求值顶替
    expect(turn.meta?.model).toBe('claude-opus-5');
    expect(turn.servedModel).not.toBe(turn.meta?.model);
    expect(turn.complete).toBe(true);
  });

  /** 变异臂 B11 */
  it('服务端说换过型号 ⇒ servedMismatch 为 true（前端不自己比字符串）', async () => {
    const turn = await runTurn([
      meta,
      delta,
      {
        type: 'done',
        message_id: 'm_77',
        finish_reason: 'stop',
        model: 'claude-opus-5',
        served_model: 'claude-sonnet-5',
        served_mismatch: true,
      },
    ]);

    expect(turn.servedMismatch).toBe(true);
  });

  /**
   * 一路走到屏幕：这一轮落定之后，用户读到的那行小字是「claude-sonnet-5 · 主力（替代）」。
   * 只验字段的话，B9 那种"字段对了、口径错了"的改法会从渲染这一侧漏过去。
   */
  it('落定值喂给落款 ⇒ 屏幕上是实际那个 +（替代），不是请求那个', async () => {
    const turn = await runTurn([
      meta,
      delta,
      {
        type: 'done',
        message_id: 'm_77',
        finish_reason: 'stop',
        model: 'claude-opus-5',
        served_model: 'claude-sonnet-5',
        served_mismatch: true,
      },
    ]);

    const label = servedModelLabel({
      served: turn.servedModel,
      requested: turn.meta?.model,
      mismatch: turn.servedMismatch,
    });
    expect(label).toBe('claude-sonnet-5 · 主力（替代）');
    // 请求的那个（opus）一个字都不许出现在屏幕上
    expect(label).not.toContain('claude-opus-5');
  });

  /** 正对照：厂商没回显时才允许退回请求值——退回是三态里的一态，不是默认态 */
  it('done 帧不带 served_model ⇒ servedModel 为 null、mismatch 为 false', async () => {
    const turn = await runTurn([
      meta,
      delta,
      { type: 'done', message_id: 'm_77', finish_reason: 'stop' },
    ]);

    expect(turn.servedModel).toBeNull();
    expect(turn.servedMismatch).toBe(false);
    // 这时候（也只有这时候）落款退回请求值
    expect(
      servedModelLabel({
        served: turn.servedModel,
        requested: turn.meta?.model,
        mismatch: turn.servedMismatch,
      }),
    ).toBe('claude-opus-5 · 深度推理');
  });

  /** 实际与请求同一个型号：不加「（替代）」，别让用户以为每轮都被换 */
  it('实际就是请求那个 ⇒ 照实标，不加（替代）', async () => {
    const turn = await runTurn([
      meta,
      delta,
      {
        type: 'done',
        message_id: 'm_77',
        finish_reason: 'stop',
        model: 'claude-opus-5',
        served_model: 'claude-opus-5',
        served_mismatch: false,
      },
    ]);

    expect(turn.servedModel).toBe('claude-opus-5');
    expect(turn.servedMismatch).toBe(false);
    expect(
      servedModelLabel({
        served: turn.servedModel,
        requested: turn.meta?.model,
        mismatch: turn.servedMismatch,
      }),
    ).toBe('claude-opus-5 · 深度推理');
  });
});
