import type { ReactNode } from 'react';
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
 */
export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DiscreetVeil />
      {children}
    </>
  );
}
