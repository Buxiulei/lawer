// app/src/lib/agent/__tests__/heartbeat.test.ts
// 首字前的心跳（manager 2026-08-19 批准的 ping 帧）。
// 用假计时器逐拍验证：间隔对不对、什么时候停、停了之后会不会漏发。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_INTERVAL_MS, startHeartbeat, type AgentEvent } from '../events';

function sink() {
  const events: AgentEvent[] = [];
  return {
    events,
    emit: (e: AgentEvent) => events.push(e),
    pings: () => events.filter((e) => e.event === 'ping'),
    /** 每帧心跳自称「已等待 N 秒」，按序取出——用来验它跨 tool 轮不倒回去 */
    waited: () =>
      events.filter((e) => e.event === 'ping').map((e) => (e.data as { waited_seconds: number }).waited_seconds),
  };
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
  it('正文在流期间不发——每帧正文把表复位，连接自己就活跃了，再发是噪音', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    vi.advanceTimersByTime(2000);
    expect(s.pings()).toHaveLength(2);

    // 每 900ms 来一帧正文（小于间隔）→ 连着 9 秒一帧心跳都不该多
    for (let i = 0; i < 10; i++) {
      hb.observe({ event: 'delta', data: { text: '手抖是正常的。' } });
      vi.advanceTimersByTime(900);
    }
    expect(s.pings()).toHaveLength(2);
    hb.stop();
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

// 首字之后模型还要跑 tool 往返，每一轮的下一次 time-to-first-token 同样是几十秒纯静默
// （产线实测一路 88.6 秒零帧、之后一次性涌出）。首字一到就永久停跳，那段静默里客户端
// 拿到的是一条状态 200 的死连接——前端看不出死活，反代照样按空闲超时掐断。
describe('贯穿 tool 轮', () => {
  it('首字 → tool 轮 30 秒静默 → 再吐字：tool 轮期间心跳必须在场', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit); // 用产线间隔，时间线就是产线的时间线

    // ① 首字前的思考期
    vi.advanceTimersByTime(20_000);
    expect(s.pings()).toHaveLength(1);

    // ② 正文开始流：每 2 秒一帧，期间一帧心跳都不多
    for (let i = 0; i < 5; i++) {
      hb.observe({ event: 'delta', data: { text: '第一段正文' } });
      vi.advanceTimersByTime(2_000);
    }
    expect(s.pings()).toHaveLength(1);

    // ③ 模型转去调工具：正文停流 30 秒 —— 修复前这一段恒为 0 帧
    const beforeTool = s.pings().length;
    vi.advanceTimersByTime(30_000);
    expect(s.pings().length - beforeTool).toBe(2); // 末帧正文后 13s、28s 各一帧

    // ④ 吐字恢复：立刻再停，不到一个间隔不许有帧
    hb.observe({ event: 'delta', data: { text: '工具结果之后的正文' } });
    const afterResume = s.pings().length;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(s.pings()).toHaveLength(afterResume);

    // ⑤ done 是终态：收尾之后一帧都不再发，定时器也不留
    hb.observe({ event: 'done', data: { message_id: 7, finish_reason: 'stop' } });
    vi.advanceTimersByTime(10 * HEARTBEAT_INTERVAL_MS);
    expect(s.pings()).toHaveLength(afterResume);
    expect(vi.getTimerCount()).toBe(0);

    // 「已等待 N 秒」是本轮开跑至今的总秒数，跨 tool 轮不复位——
    // 复位会让前端把等待时长显示成往回走
    expect(s.waited()).toEqual([15, 43, 58]);
  });

  it('全程零帧窗口不超过一个心跳间隔——反代的空闲超时永远等不到（88.6 秒实测形态）', () => {
    const arrivals: number[] = []; // 下行帧到达时刻：心跳与正文都算，反代只看有没有字节
    const hb = startHeartbeat(() => arrivals.push(Date.now()));
    const startedAt = Date.now();
    const prose = (text: string) => {
      arrivals.push(Date.now()); // 正文本身也是一帧下行数据
      hb.observe({ event: 'delta', data: { text } });
    };

    vi.advanceTimersByTime(38_000); // ① 首字前思考 38 秒
    prose('先说结论：');
    vi.advanceTimersByTime(1_000);
    prose('这笔钱算得出来。');
    vi.advanceTimersByTime(88_600); // ② tool 轮：产线实测的 88.6 秒零正文
    prose('按你给的工资基数，'); // ③ 吐字恢复
    vi.advanceTimersByTime(2_000);
    prose('N+1 是 3.2 万。');
    hb.observe({ event: 'done', data: { message_id: 7, finish_reason: 'stop' } });

    const marks = [startedAt, ...arrivals];
    const gaps = marks.slice(1).map((t, i) => t - marks[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS);
    // 且这个不变式不是靠"正文一直在流"蒙混过去的：88.6 秒里确实是心跳在扛
    expect(arrivals.filter((t) => t > startedAt + 39_000 && t < startedAt + 127_600).length).toBeGreaterThanOrEqual(5);
  });

  it('危机轮：确定性首段之后模型段非流式，那 2-4 分钟全靠心跳撑住', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    // 首段由代码毫秒级下发，模型还没开始出字——不该被当成「正文在流」，
    // 连「把等待表往后推一拍」都不行：它没有换来任何一点模型进展
    vi.advanceTimersByTime(600);
    hb.observe({ event: 'delta', data: { text: '我在，先把号码放这儿。', deterministic: true } });
    vi.advanceTimersByTime(400);
    expect(s.pings()).toHaveLength(1); // 首段没让这一拍推迟

    vi.advanceTimersByTime(119_000);
    expect(s.pings()).toHaveLength(120);

    // 模型段过完杠杆闸一次性下发，心跳到此为止
    hb.observe({ event: 'delta', data: { text: '今晚别一个人待着。' } });
    vi.advanceTimersByTime(999);
    expect(s.pings()).toHaveLength(120);
    hb.stop();
  });

  it('stop() 是终态：之后再来正文/工具帧也不复活（route 的 finally 已经收摊了）', () => {
    const s = sink();
    const hb = startHeartbeat(s.emit, { intervalMs: 1000 });

    hb.stop();
    hb.observe({ event: 'delta', data: { text: '正文' } });
    hb.observe({ event: 'record', data: { tool: 'timeline_add', id: 1, summary: 'x' } });
    vi.advanceTimersByTime(30_000);
    expect(s.pings()).toHaveLength(0);
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
