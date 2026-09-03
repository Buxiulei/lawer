'use client';

import { useEffect, useState } from 'react';
import { FreshWelcome, ReturningWelcome, WelcomeLoading } from './WelcomeScreens';
import { loadWelcomeState, type WelcomeState } from './welcomeData';

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

  if (state.kind === 'loading') return <WelcomeLoading />;
  if (state.kind === 'returning') return <ReturningWelcome caseId={state.caseId} />;
  return <FreshWelcome />;
}
