/**
 * 首诊向导的浏览器历史：**一步一个 history 条目**。
 *
 * 【为什么要有这个文件】向导的 6 步全在同一个 URL 上，步数只活在 React state 里。
 * 于是浏览器返回键第一下就把整个 /intake 弹掉——用户在第 2 步顺手按了返回，
 * 期待回到第 1 步，实际直接跳出向导（F-208）。草稿虽然不丢，但那一下很吓人。
 *
 * 【为什么是纯函数 + 注入 history】这段逻辑的失败形态是静默的：不 pushState 的版本
 * 页面照常渲染、草稿照常恢复，只有真按返回键那一下才露馅，而测试环境里没有浏览器。
 * 把它收成对 HistoryLike 的纯操作，就能拿一个假历史栈把「返回键退回上一步」
 * 与「第 1 步返回才离开」逐条量出来。
 *
 * 【为什么不 spread 现有 state】Next 的 App Router 从 14.1 起接管了
 * window.history.pushState/replaceState，会自己把路由内部状态并进来；
 * 这里只管压自己那一个键，别去抄 Next 的内部键（抄了会在返回时把同一个 key 复用两遍）。
 */

/** 压在 history state 里的步数键。**不许改名**：改了等于旧条目全成了「不是我们的」。 */
export const STEP_STATE_KEY = 'intakeStep';

/** history 的最小面：只用到这四样，测试拿假栈顶上。 */
export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string): void;
  replaceState(state: unknown, unused: string): void;
}

/**
 * 从一个 popstate 的 state 里读出步数。
 * **读不出就返回 null**，意思是「这个条目不是向导压的」——该让浏览器照常离开，
 * 那正是第 1 步按返回要发生的事。
 */
export function stepFromHistoryState(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null;
  const v = (state as Record<string, unknown>)[STEP_STATE_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * 把当前步数铺进历史栈：当前条目改写成第 0 步，再往上压到 step。
 *
 * 【为什么恢复草稿时也要铺】草稿恢复到第 3 步时栈里一个条目都没压过，
 * 返回键第一下还是直接离开——那和没修一样。铺过之后返回三下才出向导。
 */
export function seedStepHistory(h: HistoryLike, step: number): void {
  h.replaceState({ [STEP_STATE_KEY]: 0 }, '');
  for (let i = 1; i <= step; i += 1) h.pushState({ [STEP_STATE_KEY]: i }, '');
}

/** 往前走一步：压一个条目，于是返回键能退回来。**别改成 replaceState**。 */
export function pushStepHistory(h: HistoryLike, next: number): void {
  h.pushState({ [STEP_STATE_KEY]: next }, '');
}
