'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { FreshWelcome, ReturningWelcome, WelcomeLoading } from './WelcomeScreens';
import { loadWelcomeState, type WelcomeState } from './welcomeData';

/**
 * 「问出来的这个答案对应哪一屏」——纯函数，三态各一屏。
 *
 * 【为什么要从组件里抽出来（复核 MF-A）】原先这三行长在 WelcomeGate 里面，
 * 而 WelcomeGate 是个带 useEffect 的客户端组件，node 环境驱动不了它，
 * 于是这三行谁都没验过：变异实测里**把 returning 那一支整个删掉**
 * （老用户重新落回新人屏，也就是 F-201 原样复发）、以及
 * **loading 时直接画 FreshWelcome**（那一闪的「档案已创建」），
 * 两条变异都全站全绿地活了下来——判定函数、两屏渲染、取数接线各自都验过，
 * 唯独"拿判定的结果去挑屏"这一步没有。抽成纯函数，三态就都够得着了。
 *
 * 判据：__tests__/welcome-states.test.tsx 的「⑤ 挑屏」。
 */
export function screenFor(state: WelcomeState): ReactElement {
  if (state.kind === 'loading') return <WelcomeLoading />;
  if (state.kind === 'returning') return <ReturningWelcome caseId={state.caseId} />;
  return <FreshWelcome />;
}

/**
 * /welcome 上唯一那点客户端逻辑：问一次「这人是新来的还是回来的」，再挑一屏。
 *
 * 【为什么必须是客户端】判定要读 token 才拿得到他名下的案件，
 * 而 token 在 localStorage（_ui/auth 那条铁律：本站没有服务端渲染的鉴权页）。
 *
 * 【首帧为什么是骨架】问出结果之前**两屏都不许画**：先画新用户那一屏再改口，
 * 那一闪正是 F-201 里用户读到的那句「你的档案刚建好」。
 */
export function WelcomeGate() {
  const [state, setState] = useState<WelcomeState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    void loadWelcomeState().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return screenFor(state);
}
