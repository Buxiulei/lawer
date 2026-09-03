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

/** history 的最小面：只用到这几样，测试拿假栈顶上。 */
export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string): void;
  replaceState(state: unknown, unused: string): void;
  go(delta: number): void;
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
 *
 * 【为什么先看一眼当前条目】组件会**重新挂载好几次而栈还是上一轮那副栈**：
 * F5、点站内链接跳走再返回、同一个标签页第二次进 /intake。这些时候当前条目
 * 自己就写着步数（history state 跨刷新与前进后退都留着），从头铺一遍等于在它上面
 * 叠出第二段 [0,1,…]——栈成了 [1,0,1,0]：第 1 步按返回不出去，反而弹回上一段的
 * 第 2 步，要按 4 下才离开（F-208 复核 MF-3；这是修 F-208 引入的新缺陷，
 * 基线一按返回即离开）。
 *
 * 【为什么不是「铺过就整个不管」】那样会漏掉**条目步数比草稿步数浅**的那一种：
 * 同一个标签页再打开一次 /intake 是「导航到当前 URL」＝浏览器按重载处理，
 * 条目连同它的步数原样留着（实测：条目写着第 2 步、草稿却恢复到第 3 步）。
 * 一格不补的话，屏幕上是第 3 步而栈里只有 2 格，「栈深＝步数」这条不变量断了——
 * 这时点「清空重填」，resetStepHistory 按屏幕上的步数退 2 格，直接把用户退出了向导
 * （实测 afterReset 落到 /account）。所以铺过的栈只**补齐差的那几格**，一格不重复。
 *
 * 判据：step-history.test 的⑦（条目与草稿同步时不增条目，返回序列照旧 1 → 0 → 离开）
 * 与⑧（条目浅一格时补一格，清空重填仍退回第一格）。
 */
export function seedStepHistory(h: HistoryLike, step: number): void {
  // 已经铺到第几步了：读不出就是这副栈还没铺过，从当前条目起头。
  const seeded = stepFromHistoryState(h.state);
  if (seeded === null) h.replaceState({ [STEP_STATE_KEY]: 0 }, '');
  for (let i = (seeded ?? 0) + 1; i <= step; i += 1) {
    h.pushState({ [STEP_STATE_KEY]: i }, '');
  }
}

/** 往前走一步：压一个条目，于是返回键能退回来。**别改成 replaceState**。 */
export function pushStepHistory(h: HistoryLike, next: number): void {
  h.pushState({ [STEP_STATE_KEY]: next }, '');
}

/**
 * 清空重填：把历史栈退回向导的**第一格**。
 *
 * 【为什么不能只改栈顶】走到第 3 步时栈里是 [外面那页, 第1步, 第2步, 第3步]，
 * 只把栈顶改写成「第 1 步」的话，下面那两格还写着第 1、2 步，
 * 按一下返回就弹回其中一格——屏幕上是「第 2 / 6 步」的一张空表单，
 * 而「第 1 步返回才离开」当场失效（F-208 复核 MF-1 实测到的正是这一幕）。
 * 退回第一格才把「栈深＝步数」这条不变量恢复过来：清空后第 1 步，栈里也就一格。
 *
 * 【为什么 step 为 0 时什么都不做】`history.go(0)` 在浏览器里是**刷新当前页**，
 * 而这时栈深已经是 0、栈顶就是第 1 步那一格，本来就没有要退的。
 */
export function resetStepHistory(h: HistoryLike, step: number): void {
  if (step > 0) h.go(-step);
}
