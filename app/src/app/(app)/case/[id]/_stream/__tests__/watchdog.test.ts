/**
 * 看门狗：无帧超阈值就叫 onStall，切回前台就叫 onReturnToVisible，收帧（touch）清零计时。
 *
 * 【台架】不需要 jsdom：用假时钟（注入 now）+ vitest 假定时器驱动轮询，
 * 可见性用一个假源（把订阅到的回调抓在手里，手动 fire）。
 *
 * 【判据 ↔ 变异臂】
 *  a) 无帧超阈值 ⇒ onStall            —— 删掉 createWatchdog 里的 setInterval ⇒ 红
 *  d) 切回可见且仍在等答 ⇒ onReturnToVisible —— 删掉 visibility.subscribe ⇒ 红
 *  e) touch（ping 即触发）刷新计时 ⇒ 有帧就不超时
 *  另：客户端镜像的心跳/阈值与服务端真值同源（改了服务端这里没跟上就红）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS } from '@/lib/agent/events';
import {
  createWatchdog,
  HEARTBEAT_MS,
  WATCHDOG_STALL_MS,
  type VisibilitySource,
} from '../watchdog';

const DEAD_VISIBILITY: VisibilitySource = { subscribe: () => () => {} };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a) 无帧超过阈值 ⇒ onStall（看门狗定时器）', () => {
  it('一路无帧，到阈值那一格轮询发现静默死亡', () => {
    let clock = 0;
    let stalls = 0;
    const wd = createWatchdog({
      isActive: () => true,
      onStall: () => {
        stalls += 1;
      },
      onReturnToVisible: () => {},
      now: () => clock,
      stallMs: 45_000,
      pollMs: 15_000,
      visibility: DEAD_VISIBILITY,
    });

    // 心跳窗口逐格推进（时钟与定时器同步）：15/30/45s 都还没到 45s 的**严格**超出，
    // 60s 那一格 60000-0 > 45000 ⇒ 触发。
    for (let t = 15_000; t <= 60_000; t += 15_000) {
      clock = t;
      vi.advanceTimersByTime(15_000);
    }
    expect(stalls).toBeGreaterThanOrEqual(1);
    wd.stop();
  });

  it('未激活（phase 已离开等答）时即便超时也不触发', () => {
    let clock = 0;
    let stalls = 0;
    const wd = createWatchdog({
      isActive: () => false,
      onStall: () => {
        stalls += 1;
      },
      onReturnToVisible: () => {},
      now: () => clock,
      stallMs: 45_000,
      pollMs: 15_000,
      visibility: DEAD_VISIBILITY,
    });
    clock = 120_000;
    vi.advanceTimersByTime(120_000);
    expect(stalls).toBe(0);
    wd.stop();
  });
});

describe('e) touch（ping 即触发）刷新计时 ⇒ 有帧就不超时', () => {
  it('中途 touch 一次，把本会超时的那一格推到阈值之外', () => {
    let clock = 0;
    let stalls = 0;
    const wd = createWatchdog({
      isActive: () => true,
      onStall: () => {
        stalls += 1;
      },
      onReturnToVisible: () => {},
      now: () => clock,
      stallMs: 45_000,
      pollMs: 15_000,
      visibility: DEAD_VISIBILITY,
    });

    clock = 15_000;
    vi.advanceTimersByTime(15_000); // 15-0，未超
    clock = 30_000;
    vi.advanceTimersByTime(15_000); // 30-0，未超
    wd.touch(); // 收到一帧：计时基准挪到 30s
    // 无 touch 的话 60s 这一格就会超时（见上一组）；有了 touch，到 75s 仍是 45s 整、不超
    clock = 45_000;
    vi.advanceTimersByTime(15_000); // 45-30=15
    clock = 60_000;
    vi.advanceTimersByTime(15_000); // 60-30=30
    clock = 75_000;
    vi.advanceTimersByTime(15_000); // 75-30=45，未**严格**超出
    expect(stalls).toBe(0);
    wd.stop();
  });
});

describe('d) 切回可见且仍在等答 ⇒ onReturnToVisible（可见性监听）', () => {
  it('可见时回调、且只在仍在等答时才触发对账', () => {
    let fire: (() => void) | null = null;
    const visibility: VisibilitySource = {
      subscribe: (onVisible) => {
        fire = onVisible;
        return () => {};
      },
    };
    let returns = 0;
    let active = true;
    const wd = createWatchdog({
      isActive: () => active,
      onStall: () => {},
      onReturnToVisible: () => {
        returns += 1;
      },
      now: () => 0,
      visibility,
    });

    expect(fire, '看门狗没订阅可见性 ⇒ 切回前台永远不对账').not.toBeNull();
    fire!(); // 切回可见，且还在等答
    expect(returns).toBe(1);

    active = false; // 已经落定 / 已出错，不再是等答态
    fire!();
    expect(returns, '不在等答态就不该因为切回前台去对账').toBe(1);
    wd.stop();
  });
});

describe('阈值与服务端心跳同源', () => {
  it('客户端镜像的心跳值 = 服务端真值（改了 events.ts 这里没跟上就红）', () => {
    expect(HEARTBEAT_MS).toBe(HEARTBEAT_INTERVAL_MS);
  });
  it('静默阈值 = max(3×心跳, 20s)', () => {
    expect(WATCHDOG_STALL_MS).toBe(Math.max(3 * HEARTBEAT_INTERVAL_MS, 20_000));
  });
});
