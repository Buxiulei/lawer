/**
 * 底部固定层的高度真源。
 *
 * 立这一处的由头（SYS-06）：底部同时压着两层——常驻的 Tab 条，和只有部分页面才有的
 * sticky 操作条（首诊的「下一步」条 149px、问它的输入区 96px）。悬浮的低调钮和低调提示条
 * 原本各写各的常量去躲，**互相不知道对方多高**，于是 393 视口下低调钮正压在「下一步」上
 * （实测重叠 40×32，而且 z-50 > z-30，点击也被它截走）。
 *
 * 现在只有一个数：`--bottom-bar-h`。有 sticky 操作条的页面由 {@link trackBottomBar}
 * 把**实测**条高写进去，没有的页面留 globals.css 的默认值（只有 Tab 那条）。
 */

/** 视口底部被固定层占掉的总高。默认值与回退在 globals.css 的 `:root` 上。 */
export const BOTTOM_BAR_VAR = '--bottom-bar-h';

/**
 * 有 sticky 操作条时的总高 = Tab 那条（`--tab-bar-h`）+ 实测条高。
 *
 * 往上取整：这个值是给别人「躲开」用的，宁可多让半个像素，也不要因为
 * 亚像素舍入而压上去半行——量不准时一律偏向留白。
 */
export function bottomBarValue(stickyPx: number): string {
  return `calc(var(--tab-bar-h) + ${Math.ceil(stickyPx)}px)`;
}

/**
 * 把 `el` 的实测高持续写进 `root` 的 `--bottom-bar-h`，返回清理函数。
 *
 * 用 ResizeObserver 而不是量一次：条高会变——首诊那条在「先选一个阶段」这类提示出现/
 * 消失时高度就跳一档，输入区更是随输入自增高到 5 行。量一次的话，条一长高，
 * 低调钮就又压回按钮上，而且没有任何报错。
 *
 * 清理时把变量**删掉**而不是写回默认值：删掉才会回落到 globals.css 的 `:root`，
 * 否则上一页的条高会跟着路由带到下一页。
 */
export function trackBottomBar(el: HTMLElement, root: HTMLElement): () => void {
  const write = () => {
    root.style.setProperty(BOTTOM_BAR_VAR, bottomBarValue(el.getBoundingClientRect().height));
  };
  write();
  const observer = new ResizeObserver(write);
  observer.observe(el);
  return () => {
    observer.disconnect();
    root.style.removeProperty(BOTTOM_BAR_VAR);
  };
}
