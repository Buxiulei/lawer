/**
 * 中途「停止」= 停止接收，不是取消这一轮：半截回答要就地落定、留在档案里。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 服务端在客户端断开后照常答完、落库、计费（chat 路由的 finally 才释放占位）。
 * 所以点停止只该停止接收，屏幕上已收到的半截必须留成一条回答（末尾标「服务端会答完，刷新可见」）——
 * 丢掉它等于「钱花了、答案也生成了，屏幕上却什么都没留下」。
 *
 * 【台架】同 served-model-turn：react-dom/server 推一帧取出 hook 返回值，传输替身按剧本吐帧，
 * 收帧/停止的判定仍是 useChatStream 里真的那一份。用一道 gate 让流吐完 meta+delta 后**挂住**，
 * 好在「正在流」的当口调 stop()。
 *
 * 【判据 ↔ 变异臂】
 *  · 健康流中途 stop ⇒ 半截文本保留（onSettled 落一条，stopped=true）、不叫 onFailed（无错误卡）
 *  · 停止后上游即便跑完，也不再落第二条（run 正常收尾看见 liveTurn 已空即跳过）
 *  · 还没开口就停 ⇒ 不落空回答
 *  变异臂：stop 改回「只 abort + reset」（丢弃半截）⇒ 第一、二条红。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { StreamFrame } from '../frames';
import type { SettledTurn } from '../useChatStream';

const script: { frames: StreamFrame[]; hang: boolean } = { frames: [], hang: false };
const gate = { release: () => {} };

vi.mock('../httpTransport', () => ({
  createHttpTransport: () => ({
    kind: 'http' as const,
    async *send() {
      for (const frame of script.frames) yield frame;
      // 吐完剧本后挂住，模拟「服务端还在答、连接还开着」的正在流当口
      if (script.hang) await new Promise<void>((r) => (gate.release = r));
    },
  }),
  readToken: () => 'jwt-token',
  TOKEN_STORAGE_KEY: 'k',
}));

const { useChatStream } = await import('../useChatStream');

const meta: StreamFrame = {
  type: 'meta',
  thread_id: 'th_1',
  message_id: 'm_9',
  mode: '陪跑',
  intake_stage: null,
  task_class: 'critical',
  model: 'claude-opus-5',
  degraded: false,
};
const delta = (text: string): StreamFrame => ({ type: 'delta', text });

function mount(
  onSettled: (t: SettledTurn) => void,
  onFailed: (e: unknown) => void,
): ReturnType<typeof useChatStream> {
  let api: ReturnType<typeof useChatStream> | null = null;
  function Probe() {
    api = useChatStream({ caseId: '9', onSettled, onFailed });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  expect(api, '台架没取到 hook 返回值').not.toBeNull();
  return api!;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  script.frames = [];
  script.hang = false;
  gate.release = () => {};
});
afterEach(() => gate.release()); // 放掉挂住的替身，别把 pending 的流带到下一条

describe('中途停止：半截就地落定', () => {
  it('健康流中途 stop ⇒ 半截落定（stopped=true）、不叫 onFailed（无错误卡）', async () => {
    script.frames = [meta, delta('先说结论：仲裁时效'), delta('一年')];
    script.hang = true;
    const settled: SettledTurn[] = [];
    const failed: unknown[] = [];
    const api = mount((t) => settled.push(t), (e) => failed.push(e));

    api.send('时效多久？');
    await tick();
    await tick(); // 收完 meta + 两段 delta，卡在 hang 上

    api.stop();
    await tick();

    expect(settled, '停止把半截丢了 ⇒ 花了钱、答案也生成了，屏幕上却什么都没留下').toHaveLength(1);
    expect(settled[0].text).toBe('先说结论：仲裁时效一年');
    expect(settled[0].stopped).toBe(true);
    expect(failed, '停止不是错误，不该画错误卡/叫 onFailed').toHaveLength(0);
  });

  it('停止后上游即便跑完，也不再落第二条', async () => {
    script.frames = [meta, delta('半截')];
    script.hang = true;
    const settled: SettledTurn[] = [];
    const api = mount((t) => settled.push(t), () => {});

    api.send('q');
    await tick();
    await tick();
    api.stop();
    await tick();

    gate.release(); // 服务端在断开后照常答完、收尾
    await tick();
    await tick();

    expect(settled).toHaveLength(1);
    expect(settled[0].stopped).toBe(true);
  });

  it('还没开口就停（连 meta 都没到）⇒ 不落一条空回答', async () => {
    script.frames = [];
    script.hang = true;
    const settled: SettledTurn[] = [];
    const api = mount((t) => settled.push(t), () => {});

    api.send('q');
    await tick();
    api.stop();
    await tick();

    expect(settled).toHaveLength(0);
  });
});
