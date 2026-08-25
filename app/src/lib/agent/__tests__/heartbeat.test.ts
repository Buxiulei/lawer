// app/src/lib/agent/__tests__/heartbeat.test.ts
// 首字前的心跳（manager 2026-08-19 批准的 ping 帧）。
// 用假计时器逐拍验证：间隔对不对、什么时候停、停了之后会不会漏发。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_INTERVAL_MS, startHeartbeat, type AgentEvent } from '../events';

function sink() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e), pings: () => events.filter((e) => e.event === 'ping') };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('间隔', () => {
  it('每 15 秒一帧，且默认间隔就是 HEARTBEAT_INTERVAL_MS', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(s.pings()).toHaveLength(0); // 差 1 毫秒都还不发

    vi.advanceTimersByTime(1);
    expect(s.pings()).toHaveLength(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(s.pings()).toHaveLength(4);
    hb.stop();
  });

  it('每帧带「已等待秒数」，单调递增，供前端显示等待时长', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    vi.advanceTimersByTime(3000);
    const waited = s.pings().map((p) => (p.data as { waited_seconds: number }).waited_seconds);
    expect(waited).toEqual([1, 2, 3]);
    hb.stop();
  });
});

describe('停止条件', () => {
  it('见到首个 delta 立刻停——正文一开始流，连接自己就活跃了，再发是噪音', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    vi.advanceTimersByTime(2000);
    expect(s.pings()).toHaveLength(2);

    hb.observe({ event: 'delta', data: { text: '手抖是正常的。' } });
    vi.advanceTimersByTime(10_000);
    expect(s.pings()).toHaveLength(2); // 一帧都没再多
  });

  it('meta / notice / record 这些非正文事件不停心跳（它们不代表模型开始出字）', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    hb.observe({ event: 'notice', data: { code: 'KNOWLEDGE_MISS', message: 'x' } });
    hb.observe({ event: 'record', data: { tool: 'timeline_add', id: 1, summary: 'x' } });
    vi.advanceTimersByTime(2000);
    expect(s.pings()).toHaveLength(2);
    hb.stop();
  });

  it('stop() 之后不再发，且重复 stop 安全（finally 里会再调一次）', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    hb.stop();
    hb.stop();
    vi.advanceTimersByTime(10_000);
    expect(s.pings()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0); // 定时器没泄漏
  });

  it('一条正文都没有就结束（如纯工具轮后直接收尾）时，stop 仍清干净定时器', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });
    vi.advanceTimersByTime(500);
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('线格式', () => {
  it('ping 帧能被 encodeSse 正常编码（前端按 event 名分支）', async () => {
    const { encodeSse } = await import('../events');
    expect(encodeSse({ event: 'ping', data: { waited_seconds: 15 } })).toBe(
      'event: ping\ndata: {"waited_seconds":15}\n\n',
    );
  });
});
