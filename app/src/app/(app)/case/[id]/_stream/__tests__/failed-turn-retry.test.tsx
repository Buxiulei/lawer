/**
 * 重试**不许把问题再发一遍**——它得指名道姓地说"重试的是那一轮"。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * (naive-qa-2 F-203) 失败横幅上的「重试」此前是 `run(lastMessage)`：把同一句话
 * 当成一条**新消息**再 POST 一次。服务端每次都会插一条 user 行，于是重试三次，
 * 档案里那句问话就出现四遍——用户翻历史时看见自己把同一件事讲了四回。
 * 修法是带上 `retry_of`（失败那条 assistant 行的 id），正文由服务端从库里取。
 *
 * 这一层要钉住的是**前端有没有把那个 id 带出去**：带不出去，服务端那半边修得再对也用不上。
 *
 * 【台架】同 served-model-turn：react-dom/server 推一帧取出 hook 返回值，
 * 传输层是替身（记下每次请求），收帧与重试的判定仍是 useChatStream 里真的那一份。
 *
 * 【变异臂】
 *  · M-C1 收帧的 error 分支不记 `frame.message_id`   ⇒「重试带 retry_of」红
 *  · M-C2 `retry()` 改回 `run(lastMessage.current)`  ⇒「重试带 retry_of」「不重发原文」红
 *  · M-C3 httpTransport 的 body 不带 retry_of        ⇒ 同目录 http-transport-retry 那组红
 *  · M-R6 收帧的 error 分支不叫 onFailed             ⇒「这一轮失败了要叫一声」红
 *  · M-R7 onFailed 只传 code（不走 toStreamError）    ⇒「余额一并带出去」红
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamFrame } from '../frames';

/** 传输替身：记下每次请求，按剧本吐帧 */
const bus: { frames: StreamFrame[][]; sent: { message: string; retryOf?: string }[] } = {
  frames: [],
  sent: [],
};

vi.mock('../httpTransport', () => ({
  createHttpTransport: () => ({
    kind: 'http' as const,
    async *send({ message, retryOf }: { message: string; retryOf?: string }) {
      bus.sent.push({ message, retryOf });
      for (const frame of bus.frames[bus.sent.length - 1] ?? []) yield frame;
    },
  }),
  readToken: () => 'jwt-token',
  TOKEN_STORAGE_KEY: 'k',
}));

const { useChatStream, reduce, INITIAL } = await import('../useChatStream');

const ASK = 'HR 让我今天签自愿离职。';

/** 服务端把失败落成了 messages#77，error 帧带回它的 id */
const FAILED: StreamFrame = {
  type: 'error',
  code: 'AGENT_FAILED',
  message: '这一轮没能生成回答：模型服务这会儿连不上。',
  message_id: '77',
};

/** 连都没连上（前端自己造的那一帧）：没有落成行，也就没有 id */
const OFFLINE: StreamFrame = { type: 'error', code: 'NETWORK', message: '网络断了。' };

function mount(onFailed?: (error: unknown) => void) {
  let api: ReturnType<typeof useChatStream> | null = null;
  function Probe() {
    api = useChatStream({ caseId: '9', onSettled: () => {}, onFailed });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  expect(api, '台架没取到 hook 返回值').not.toBeNull();
  return api!;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  bus.frames = [];
  bus.sent = [];
});

describe('error 帧收进状态', () => {
  it('带回来的 message_id 进 error.messageId（横幅要靠它给出重试入口）', () => {
    const next = reduce({ ...INITIAL, phase: 'streaming' }, { type: 'frame', frame: FAILED });
    expect(next.phase).toBe('error');
    expect(next.error).toMatchObject({ code: 'AGENT_FAILED', messageId: '77' });
  });

  it('没带 message_id ⇒ messageId 为 undefined，不替它编一个', () => {
    const next = reduce({ ...INITIAL, phase: 'streaming' }, { type: 'frame', frame: OFFLINE });
    expect(next.error?.messageId).toBeUndefined();
  });
});

describe('★重试走 retry_of，不把问题再发一遍', () => {
  it('失败落成了行 ⇒ 重试只带 retry_of，正文是空的（服务端从库里取）', async () => {
    bus.frames = [[FAILED], []];
    const api = mount();
    api.send(ASK);
    await settle();
    api.retry();
    await settle();

    expect(bus.sent).toHaveLength(2);
    expect(bus.sent[0]).toEqual({ message: ASK, retryOf: undefined });
    expect(bus.sent[1].retryOf, '重试没带上失败那一行的 id ⇒ 服务端会当成一条新消息').toBe('77');
    expect(bus.sent[1].message, '把原文再发一遍就是在档案里插第二句同样的问话').toBe('');
  });

  it('从历史里点某一条失败轮重试（刷新之后那条）⇒ 同样只带那一行的 id', async () => {
    bus.frames = [[]];
    const api = mount();
    api.retryFailed('123');
    await settle();
    expect(bus.sent).toEqual([{ message: '', retryOf: '123' }]);
  });

  /** 反向对照：没落成行时不许硬编一个 id，那时"照原文再发一次"才是对的 */
  it('连都没连上（没有 message_id）⇒ 退回照原文再发一次', async () => {
    bus.frames = [[OFFLINE], []];
    const api = mount();
    api.send(ASK);
    await settle();
    api.retry();
    await settle();

    expect(bus.sent[1]).toEqual({ message: ASK, retryOf: undefined });
  });

  it('重试成功之后再失败一次 ⇒ 记的是**新**那一行的 id，不是上一轮的', async () => {
    bus.frames = [[FAILED], [{ ...FAILED, message_id: '88' } as StreamFrame], []];
    const api = mount();
    api.send(ASK);
    await settle();
    api.retry();
    await settle();
    api.retry();
    await settle();

    expect(bus.sent.map((s) => s.retryOf)).toEqual([undefined, '77', '88']);
  });
});

/**
 * 【这一轮以 error 帧收场，得叫调用方一声】(RV-1)
 * 页面是**先把问话画上去再发**的。被余额闸拦下时服务端一个字都没写库，
 * 那条乐观回显必须撤——而页面只有在流层告诉它"这一轮黄了"时才撤得动。
 * 错误进 state.error 是给屏幕看的，不等于"通知过调用方"：
 * 少了这一声，Workbench 那半边接得再对，回显也永远撤不掉。
 */
describe('★失败了要叫调用方一声（回显得有人撤）', () => {
  const REFUSED: StreamFrame = {
    type: 'error',
    code: 'GONGDAO_EXHAUSTED',
    message: '公道值余额 0，这一轮开不了。',
    balance: 0,
  };

  it('402 那一帧 ⇒ onFailed 被叫到，且**余额一并带出去**（横幅与撤回显读同一份）', async () => {
    const seen: unknown[] = [];
    bus.frames = [[REFUSED]];
    const api = mount((e) => seen.push(e));
    api.send(ASK);
    await settle();

    expect(seen, '流层没通知调用方 ⇒ 那条回显没人撤').toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: 'GONGDAO_EXHAUSTED', balance: 0 });
  });

  it('普通失败也叫（撤不撤由调用方按错误码定，不由这一层替它裁）', async () => {
    const seen: unknown[] = [];
    bus.frames = [[FAILED]];
    const api = mount((e) => seen.push(e));
    api.send(ASK);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: 'AGENT_FAILED', messageId: '77' });
  });

  it('正对照：这一轮好好答完 ⇒ 一声都不叫', async () => {
    const seen: unknown[] = [];
    bus.frames = [[{ type: 'delta', text: '好。' } as StreamFrame, { type: 'done' } as StreamFrame]];
    const api = mount((e) => seen.push(e));
    api.send(ASK);
    await settle();
    expect(seen).toEqual([]);
  });
});
