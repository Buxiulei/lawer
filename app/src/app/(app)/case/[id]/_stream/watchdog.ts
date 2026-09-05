'use client';

/**
 * 对话流的看门狗：**连接静默死亡**时把这一轮从「永远转圈」里救出来。
 *
 * 【为什么要它 —— 2026-09-04 真机（手机与电脑都有）】
 * SSE 这条流会**挂而不抛**：手机切后台 iOS 杀掉 fetch、网络切换、代理半开——
 * 连接实际断了，但 `reader.read()` 既不返回也不 reject，就那么挂着。于是：
 *   · 收帧循环停在某一帧后面，`phase` 永远停在 connecting/waiting/streaming；
 *   · Composer 的 `streaming` 恒真，发送键变成停止键、点了也没用（点击被吞）；
 *   · 服务端那一轮照样答完、照样落库（route 的 finally 释放占位），
 *     可页面永远不刷新——「答案在库里，屏幕上没有」。
 * transport 只在 fetch **抛错**时才发 NETWORK 错误帧；挂而不抛的连接走不到那里。
 *
 * 这个文件只做**探测**：无帧超过阈值就叫一声（onStall），从后台切回来也叫一声
 * （onReturnToVisible）。叫到之后去库里把答案取回来（对账）是 reconcile.ts 的事，
 * 由 useChatStream 把两者接起来。分开是为了各自能单测：这里用假时钟 + 假可见性源，
 * 不需要 jsdom。
 */


/**
 * 服务端心跳间隔的**镜像**。真值在 lib/agent/events.ts 的 HEARTBEAT_INTERVAL_MS，
 * 这里不能 import 它（那是服务端 agent 模块，不该进客户端包），所以抄一份，
 * 再由 watchdog.heartbeat-sync.test 把两边钉死——改了那边这里没跟上，测试当场点名。
 */
export const HEARTBEAT_MS = 15_000;

/**
 * 无帧多久算「连接静默死亡」。
 * = max(3 × 心跳, 20s)：3 个心跳 = 连着三次该到没到的 ping（偶发一次晚点不误伤）；
 * 20s 地板兜住心跳被调小到 <7s 的情形。心跳 15s 时阈值 45s。
 */
export const WATCHDOG_STALL_MS = Math.max(3 * HEARTBEAT_MS, 20_000);

/** 页面可见性来源。抽成接口是为了单测能塞一个假的进来（node 里没有 document）。 */
export interface VisibilitySource {
  /** 订阅「变为可见」这一刻；返回退订函数。只在 visible 时回调，隐藏时不回调。 */
  subscribe: (onVisible: () => void) => () => void;
}

/** 默认取真实 document；SSR / node 下没有它，给一个永不回调的空源。 */
export function documentVisibility(): VisibilitySource {
  if (typeof document === 'undefined') {
    return { subscribe: () => () => {} };
  }
  return {
    subscribe: (onVisible) => {
      const handler = () => {
        if (document.visibilityState === 'visible') onVisible();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

export interface Watchdog {
  /** 收到任意一帧（含 ping）时叫一声：把静默计时清零。开跑时也要叫一次。 */
  touch: () => void;
  /** 拆掉轮询定时器与可见性监听。组件卸载时必须调。 */
  stop: () => void;
}

/**
 * 起一个看门狗。它自己持有轮询定时器与可见性监听——删掉哪一个，对应的单测就红，
 * 这正是要的：这两处是「无帧探测」与「切回前台探测」的唯一实现点。
 *
 * @param opts.isActive  当前 phase 是否处在**会静默死亡**的那几态（connecting/waiting/streaming）。
 *   进入对账（reconnecting）后应返回 false，好让看门狗不再重复触发同一轮。
 * @param opts.onStall           无帧超过阈值时回调（去对账）。
 * @param opts.onReturnToVisible 从后台切回可见、且此刻仍在等答时回调（去对账）。
 */
export function createWatchdog(opts: {
  isActive: () => boolean;
  onStall: () => void;
  onReturnToVisible: () => void;
  now?: () => number;
  stallMs?: number;
  pollMs?: number;
  visibility?: VisibilitySource;
}): Watchdog {
  const now = opts.now ?? Date.now;
  const stallMs = opts.stallMs ?? WATCHDOG_STALL_MS;
  const pollMs = opts.pollMs ?? HEARTBEAT_MS;
  const visibility = opts.visibility ?? documentVisibility();

  let lastFrameAt = now();

  const timer = setInterval(() => {
    if (!opts.isActive()) return;
    if (now() - lastFrameAt > stallMs) opts.onStall();
  }, pollMs);

  const unsubscribe = visibility.subscribe(() => {
    if (opts.isActive()) opts.onReturnToVisible();
  });

  return {
    touch() {
      lastFrameAt = now();
    },
    stop() {
      clearInterval(timer);
      unsubscribe();
    },
  };
}
