import { describe, expect, it } from 'vitest';
import type { MetaFrame } from '../frames';
import { INITIAL, reduce } from '../useChatStream';

const meta: MetaFrame = {
  type: 'meta',
  thread_id: 'th_1',
  message_id: 'm_1',
  mode: '陪跑',
  intake_stage: null,
  task_class: 'critical',
  model: 'claude-opus-5',
  degraded: false,
};

/** meta 已到、还在等模型的那一刻 */
function waiting() {
  return reduce(reduce(INITIAL, { type: 'start' }), { type: 'frame', frame: meta });
}

describe('deterministic delta', () => {
  it('追加文本但不结束等待态', () => {
    const before = waiting();
    const after = reduce(before, {
      type: 'frame',
      frame: { type: 'delta', text: '我在，先别急。', deterministic: true },
    });

    expect(after.phase).toBe('waiting');
    expect(after.waitBaseAt).toBe(before.waitBaseAt);
    expect(after.text).toBe('我在，先别急。');
    expect(after.deterministicChars).toBe('我在，先别急。'.length);
  });

  it('首段之后 ping 仍然校准计时', () => {
    const state = reduce(waiting(), {
      type: 'frame',
      frame: { type: 'delta', text: '我在。', deterministic: true },
    });
    const pinged = reduce(state, {
      type: 'frame',
      frame: { type: 'ping', waited_seconds: 45 },
    });

    expect(pinged.phase).toBe('waiting');
    expect(pinged.waitBaseAt).not.toBeNull();
    expect(Math.round((Date.now() - pinged.waitBaseAt!) / 1000)).toBe(45);
  });

  it('首个非 deterministic delta 才结束等待态', () => {
    const state = reduce(waiting(), {
      type: 'frame',
      frame: { type: 'delta', text: '我在。', deterministic: true },
    });
    const streaming = reduce(state, {
      type: 'frame',
      frame: { type: 'delta', text: '先说结论：' },
    });

    expect(streaming.phase).toBe('streaming');
    expect(streaming.waitBaseAt).toBeNull();
  });

  it('全文含 deterministic 前缀，前缀长度不因正文增长', () => {
    let state = reduce(waiting(), {
      type: 'frame',
      frame: { type: 'delta', text: '我在。', deterministic: true },
    });
    state = reduce(state, {
      type: 'frame',
      frame: { type: 'delta', text: '别急。', deterministic: true },
    });
    state = reduce(state, { type: 'frame', frame: { type: 'delta', text: '先说结论：' } });
    state = reduce(state, { type: 'frame', frame: { type: 'delta', text: '时效一年。' } });

    expect(state.text).toBe('我在。别急。先说结论：时效一年。');
    expect(state.deterministicChars).toBe('我在。别急。'.length);
    expect(state.text.slice(0, state.deterministicChars)).toBe('我在。别急。');
  });

  it('没有 deterministic 首段时前缀长度为 0，delta 直接进流式', () => {
    const state = reduce(waiting(), {
      type: 'frame',
      frame: { type: 'delta', text: '先说结论：' },
    });

    expect(state.phase).toBe('streaming');
    expect(state.deterministicChars).toBe(0);
  });
});
