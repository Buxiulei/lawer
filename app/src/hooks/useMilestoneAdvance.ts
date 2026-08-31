'use client';

import { useRef, type RefObject } from 'react';

import { EASE, HAPTIC, MO, haptic, sec, useReducedMotion } from '@/app/_ui/motion';
import { gsap, useGSAP } from './gsap';
import { planAdvance } from './milestone-advance-plan';

/** 落章盖住后停多久再淡出。停留不是动画，减弱动效下也不需要它——那时章根本不渲染。 */
const SEAL_HOLD_MS = 1200;

/**
 * 里程碑推进编排（《移动端动效语言》§2 A-2）。**一个案子一生最多 8 次。**
 *
 * 目标元素由 `data-mo-*` 在 `MilestoneTrack` 上标出，一律**过 scope 找**：
 * 本仓库多个同名组件会同时在屏（`ActionCard` 在驾驶舱和对话流里各有一份），
 * 裸选择器会跨组件命中。
 *
 * 两条硬约束都在 `planAdvance` 里，不在这儿：
 * 首屏不补播、减弱动效整条不建。这里只负责把计划放出来。
 *
 * 第三条硬约束在这儿：**落章可能根本不存在**（低调模式下 `Seal` 返回 null），
 * 所以后续步骤不许挂在它身上——时间轴用绝对位置排，不用 `onComplete` 串。
 */
export function useMilestoneAdvance(
  scope: RefObject<HTMLElement | null>,
  /** 「进行中」落在第几格。全程走完没有进行中时传 `-1` */
  stageIndex: number,
) {
  const reduce = useReducedMotion();
  // 上一次看到的格号。**初值 null ＝ 本会话还没看过**，
  // 首屏那一次挂载只把它填上，不播——用户什么都没做，不该看见一场庆祝。
  const seen = useRef<number | null>(null);

  useGSAP(
    () => {
      const prev = seen.current;
      seen.current = stageIndex;

      const plan = planAdvance(prev, stageIndex, reduce);
      if (!plan || plan.kind !== 'play') return;

      const root = scope.current;
      if (!root) return;

      const line = root.querySelector<HTMLElement>(`[data-mo-line="${stageIndex}"]`);
      const dot = root.querySelector<HTMLElement>(`[data-mo-dot="${stageIndex}"]`);
      // 低调模式下这个是 null，整条编排照走
      const seal = root.querySelector<HTMLElement>('[data-seal]');

      const tl = gsap.timeline();
      for (const step of plan.steps) {
        const at = sec(step.at);
        const dur = sec(step.dur);
        if (step.target === 'line' && line) {
          // 画实的是 scaleX 不是 width：动 width 会把八格轨道整行重排
          tl.fromTo(
            line,
            { scaleX: 0, transformOrigin: 'left center' },
            { scaleX: 1, duration: dur, ease: EASE.out },
            at,
          );
        }
        if (step.target === 'dot' && dot) {
          tl.fromTo(dot, { scale: 0.6 }, { scale: 1, duration: dur, ease: EASE.out }, at);
        }
        if (step.target === 'seal' && seal) {
          tl.fromTo(
            seal,
            { y: 10, rotation: 14, scale: 1.9, autoAlpha: 0 },
            { y: 0, rotation: 9, scale: 1, autoAlpha: 0.92, duration: dur, ease: EASE.seal },
            at,
          );
          tl.to(
            seal,
            { autoAlpha: 0, duration: sec(MO.exit), ease: EASE.in },
            at + dur + sec(SEAL_HOLD_MS),
          );
        }
      }

      // 触觉与落章同帧。**不随减弱动效关闭是另一回事**——这里之所以不响，
      // 是因为整条编排在减弱动效下压根没建，不是因为触觉被关了。
      tl.call(
        () => {
          haptic(HAPTIC.seal);
        },
        undefined,
        sec(plan.hapticAt),
      );
    },
    // stageIndex 变了就重跑；**不开 revertOnUpdate**：revert 会把上一条编排的终态
    // 擦回起点，而终态正是 React 已经渲染好的新状态。
    { dependencies: [stageIndex, reduce], scope },
  );
}
