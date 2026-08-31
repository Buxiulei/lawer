/**
 * 里程碑推进编排的**纯计算部分**。
 *
 * 单独成文件不是为了分层好看，是为了它能在 node 里被测：本仓库 vitest 跑 node 环境，
 * 没有 DOM 也没有 gsap。而这条编排上有两个「不写必出 bug、出了没人看得见」的判据——
 * 「首屏不补播」与「减弱动效整条不建」——它们的失败形态都是**画面看起来很正常**：
 * 一个是用户什么都没做却看见一场庆祝，一个是前庭敏感者被甩了一下。
 * 两者都不会报错，所以由测试钉着，不靠肉眼。
 *
 * 时间表（毫秒）逐条对应《移动端动效语言》§2 A-2。
 */

import { MO } from '@/app/_ui/motion';

/** 编排里的一步。`at` 是相对编排起点的偏移，`dur` 是本步时长，两者都是毫秒。 */
export interface AdvanceStep {
  /** 动谁。由 `useMilestoneAdvance` 在 scope 内按此名找元素 */
  target: 'line' | 'dot' | 'seal';
  at: number;
  dur: number;
}

export type AdvancePlan =
  /** 减弱动效：整条不建，直接是终态。**不是把时长改小** */
  | { kind: 'snap' }
  | { kind: 'play'; steps: readonly AdvanceStep[]; hapticAt: number };

/**
 * 该不该播、播什么。
 *
 * @param prev  上一次看到的「进行中」格下标。`null` ＝ 本会话还没看过（首屏）
 * @param next  这一次的「进行中」格下标
 * @param reduce 用户要求减弱动效
 */
export function planAdvance(
  prev: number | null,
  next: number,
  reduce: boolean,
): AdvancePlan | null {
  // **首屏不补播。** 打开应用时轨道已经是新状态，这不是「刚刚发生的推进」。
  // 补播会让用户以为自己刚才那一下点出了什么——他什么都没做。
  if (prev === null) return null;

  // 只播前进。回退（谈崩重回仲裁）是坏消息，庆祝它是荒唐的；
  // 原地不动更不用播。
  if (next <= prev) return null;

  // 装饰性的整条不建。终态本来就由 React 渲染出来了，什么都不做就是终态。
  if (reduce) return { kind: 'snap' };

  return {
    kind: 'play',
    steps: [
      // 上一格连接线由左至右画实。**不动 width**——那会重排整行八格
      { target: 'line', at: 0, dur: 240 },
      // 新格圆点弹出
      { target: 'dot', at: 340, dur: 200 },
      // 落章：新格上方浮出土八鼠印
      { target: 'seal', at: 540, dur: MO.seal },
    ],
    // 与落章同帧
    hapticAt: 560,
  };
}

/** 编排核心段（不含落章的驻留与淡出）总长，用于自检不超 `--mo-track` */
export function advanceCoreMs(plan: AdvancePlan | null): number {
  if (!plan || plan.kind !== 'play') return 0;
  return plan.steps
    .filter((s) => s.target !== 'seal')
    .reduce((max, s) => Math.max(max, s.at + s.dur), 0);
}
