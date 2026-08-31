'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 路由过渡（工单 B3）。
 *
 * 【同级四 Tab = 交叉淡入，不做方向滑动】
 * 驾驶舱 / 问它 / 证据 / 文书之间**没有前后关系**。方向滑动会编造一个不存在的层级：
 * 从「证据」滑到「文书」如果是往左推，用户会以为文书在证据后面——它不在。
 * 淡入起点不取 0 而取 .55：全黑一帧再亮起来比直接换更慢，读起来像加载失败。
 *
 * 【下钻 = 从下方升起】
 * 列表 → 详情是真有层级的，方向在这里编码层级：往深处走是从下面来。
 * **返回不做动效**——用户已经决定离开了，退场只会推迟他要看的东西。
 *
 * 【为什么不用 View Transitions】
 * 两条理由，第二条比第一条重要：
 *  1. Next 16 / React 19 的 `<ViewTransition>` 仍是实验状态。
 *  2. **它与低调模式在语义上冲突**：View Transitions 的实现方式就是
 *     「把旧页面的静态快照留在屏幕上交叉淡出」。切换动画进行中（约 200ms 窗口）
 *     按下低调钮，**屏上那张快照是明文的，且不受任何 CSS filter 管辖**。
 *     窗口很短、概率很低——但这恰好就是低调模式要防的那个瞬间。
 *     `bootstrap.ts` 为了「首屏不闪一帧明文」已经专门做了首屏脚本落属性，
 *     不该在路由层把这个保证还回去。
 *
 * 【减弱动效】不在这里判断：两条都是纯 CSS keyframes，globals.css 底部那条
 * 全局规则会把时长压掉，`both` 让元素落在终态（不透明、无位移）。
 * 动效本身也不承载任何信息——切没切页面看内容就知道。
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const prev = useRef<string | null>(null);
  const from = prev.current;

  useEffect(() => {
    prev.current = pathname;
  }, [pathname]);

  return (
    <div key={pathname} data-route-anim={transitionKind(from, pathname)}>
      {children}
    </div>
  );
}

/** 案件根：`/case/<id>`，后面跟着的部分单独取出来数层数。 */
const CASE_ROOT = /^(\/case\/[^/]+)(?:\/(.*))?$/;

/**
 * `none` = 首次挂载。**硬加载不补播入场**：内容已经在那了，再淡一次只是拖慢首屏。
 * `rise` = 真的下钻了一层。其余一律 `cross`。
 *
 * 【为什么不能只看「新路径是不是旧路径的前缀延伸」】
 * 底部四栏是 `/case/<id>`（驾驶舱）与它的一级子路径（问它 / 证据 / 文书）。
 * 光看前缀的话，驾驶舱 → 证据会被判成下钻——而它们是**同级**，
 * 方向滑动会编造一个不存在的层级。所以案件内先按「离案件根几层」判：
 * 一层以内都是 Tab（同级，交叉淡入），两层起才是下钻。
 *
 * 这个判据与 `navItems.tsx` 的四栏模型是同一件事，但**故意不 import 它**：
 * 那样要多拿一个 caseId 参数、还要把 AppShell 里的 caseIdFrom 挪出来，
 * 而 AppShell 是全站热点文件、正有别的分支在改案件路由。
 * 四栏的形状（案件根 + 一级子路径）本身是稳定的产品事实，够用。
 */
export function transitionKind(
  from: string | null,
  to: string,
): 'none' | 'rise' | 'cross' {
  if (from === null) return 'none';
  if (from === to) return 'cross';

  const a = CASE_ROOT.exec(from);
  const b = CASE_ROOT.exec(to);
  if (a && b && a[1] === b[1]) {
    const depth = b[2] ? b[2].split('/').filter(Boolean).length : 0;
    if (depth <= 1) return 'cross';
    return to.startsWith(`${from}/`) ? 'rise' : 'cross';
  }

  const base = from === '/' ? '' : from.replace(/\/+$/, '');
  return to.startsWith(`${base}/`) ? 'rise' : 'cross';
}
