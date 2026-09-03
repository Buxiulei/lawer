import type { ReactNode } from 'react';
import { SessionGate } from '@/app/_ui/session';
import { DiscreetVeil } from '@/app/_ui/veil';

/**
 * /welcome 的布局：只为把**按住看清**那道手势层挂进来。
 *
 * 【为什么挂在 layout 而不是 page 里】page.tsx 是 server component，
 * 而 DiscreetVeil 要 useDiscreet（客户端 context）。挂进 page 就得把整页
 * 转成客户端组件，或者在页面里再包一层——两条都在**页面**上加东西，
 * 而 landing-byo.test 的 J8 是直接 `renderToStaticMarkup(<WelcomePage />)`
 * 渲染那一页的（没有 DiscreetProvider），页面里冒出 useDiscreet 就当场炸。
 * 挂在 layout 上，页面本身仍是一个可以裸渲的纯 server component。
 *
 * 【手势层不复制第二份】这里用的就是 AppShell 用的那一个 DiscreetVeil
 * （_ui/veil，文档级委托，挂一次即可）。DiscreetProvider 与 ToastProvider
 * 都在**根布局**里，这一页照样在它们里面——只是原先没人把手势层挂上，
 * 于是这一屏的糊层是糊死的：糊了揭不开。
 *
 * 判据：__tests__/welcome-discreet.test.tsx 的「揭开手势存在」。
 *
 * 【登录态失效的闸门也挂在这儿（F-202 的同一个出路，不是另抄一份）】
 * 这一页要靠接口回答"你是新来的还是回来的"。token 坏掉时那几条请求全是 401，
 * 问不出答案就只能退回新人那一屏——那正好是 F-201 要消灭的那句话。
 * 挂上闸门，失效时整块换成「去登录」，而不是拿一屏"你的档案刚建好"糊弄一个老用户。
 */
export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DiscreetVeil />
      <SessionGate next="/welcome">{children}</SessionGate>
    </>
  );
}
