'use client';

import { useCallback, useRef, useState } from 'react';

import { EASE, MO, sec, useReducedMotion } from '@/app/_ui/motion';
import { gsap, useGSAP } from './gsap';

/**
 * 勾完到收起之间的停留。**这不是动效时长，是一段可读窗口**——
 * 让人看见划线画上、顶栏计数跳了一格，再决定要不要撤销。
 * 所以它**不随减弱动效缩短**：减弱动效关的是运动，不是思考时间。
 */
const UNDO_HOLD_MS = 700;

/**
 * 行动卡勾完之后自己收起（《移动端动效语言》§2 B）。
 *
 * 「完成庆祝」的正确形态是**下一件事出现**，不是彩带。
 * 驾驶舱只推一件事，这一行让开，下一件才有地方站。
 *
 * 收起过程中行上出现「撤销」，点了立刻反向——动效期间 UI 保持可点，
 * 用户下一次触摸立刻夺回控制权（`.kill()`，不等 `onComplete`）。
 *
 * **只认本会话内发生的勾选**：挂载时就已经是完成态的行不会自己消失，
 * 否则从别的页面回来会看见一排行凭空塌掉。
 */
export function useDoneCollapse(done: boolean, onCollapsed: () => void) {
  const wrap = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [undoable, setUndoable] = useState(false);

  const wasDone = useRef(done);
  const timer = useRef<number | null>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  // 回调放 ref：它每次渲染都是新函数，进依赖数组会让编排每帧重建
  const collapsed = useRef(onCollapsed);
  collapsed.current = onCollapsed;

  useGSAP(
    (_context, contextSafe) => {
      if (done === wasDone.current) return;
      wasDone.current = done;
      if (!done) {
        setUndoable(false);
        return;
      }
      setUndoable(true);

      // `contextSafe` 由 useGSAP 必给，类型上是可选的
      const collapse = contextSafe!(() => {
        const el = wrap.current;
        // **减弱动效 = 跳到终态，不是缩短**：终态就是这一行不在了
        if (!el || reduce) {
          collapsed.current();
          return;
        }
        // height 是白名单里点名的四条 layout 属性之一：作用域只有一行 wrapper（≤120px），
        // 不是页面。收起必须真的把位置让出来，transform 做不到这件事。
        tween.current = gsap.to(el, {
          height: 0,
          autoAlpha: 0,
          duration: sec(MO.sheet),
          ease: EASE.in,
          onComplete: () => collapsed.current(),
        });
      });

      const id = window.setTimeout(collapse, UNDO_HOLD_MS);
      timer.current = id;
      return () => window.clearTimeout(id);
    },
    { dependencies: [done], scope: wrap },
  );

  /** 撤销：立刻停手并还原，剩下的（把状态改回待办）由调用方做 */
  const undo = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    tween.current?.kill();
    tween.current = null;
    if (wrap.current) gsap.set(wrap.current, { clearProps: 'height,opacity,visibility' });
    setUndoable(false);
  }, []);

  return { wrap, undoable, undo };
}
