/**
 * 里程碑推进编排的判据。
 *
 * 三条判据的失败形态**都不会报错**：
 * - 首屏补播：用户什么都没做，却看见一场庆祝，以为自己刚才点出了什么；
 * - 回退也播：案子谈崩退回协商，界面替他庆祝；
 * - 减弱动效不降级：前庭敏感者被甩一下。
 *
 * 三样都得靠人在真机上撞见，所以由测试钉着。
 */
import { describe, expect, it } from 'vitest';

import { MO } from '@/app/_ui/motion';
import { advanceCoreMs, planAdvance } from '../milestone-advance-plan';

describe('该不该播', () => {
  it('首屏（本会话还没看过）不补播——轨道已经是新状态，那不是刚发生的推进', () => {
    expect(planAdvance(null, 3, false)).toBeNull();
  });

  it('原地不动不播', () => {
    expect(planAdvance(2, 2, false)).toBeNull();
  });

  it('回退不播：撤回仲裁退回协商是坏消息，庆祝它是荒唐的', () => {
    expect(planAdvance(3, 1, false)).toBeNull();
  });

  it('全程走完（没有进行中，-1）不播', () => {
    expect(planAdvance(7, -1, false)).toBeNull();
  });

  it('本会话内前进一格才播', () => {
    expect(planAdvance(0, 1, false)?.kind).toBe('play');
  });
});

describe('减弱动效降级', () => {
  /**
   * **降级不是把时长改小，是整条不建。**
   * 装饰性的东西播 0.01ms 仍然会闪一下，而里程碑达成的静止判据
   * （那一格底下由「进行中」换成日期）本来就在，动效只是加速识别。
   */
  it('要求减弱时不给任何步骤', () => {
    const plan = planAdvance(0, 1, true);
    expect(plan).toEqual({ kind: 'snap' });
    expect(plan && 'steps' in plan).toBe(false);
  });

  it('减弱下即使前进多格也是 snap，不是「短一点的 play」', () => {
    expect(planAdvance(0, 7, true)).toEqual({ kind: 'snap' });
  });

  it('减弱不会把「不该播」变成「该播」——首屏与回退仍然是 null', () => {
    expect(planAdvance(null, 3, true)).toBeNull();
    expect(planAdvance(3, 1, true)).toBeNull();
  });
});

describe('编排本身的预算', () => {
  const plan = planAdvance(0, 1, false);

  it('每一步 ≤250ms，落章是唯一点名的例外', () => {
    if (!plan || plan.kind !== 'play') throw new Error('该给 play');
    for (const step of plan.steps) {
      if (step.target === 'seal') {
        expect(step.dur).toBe(MO.seal);
        continue;
      }
      expect(step.dur, step.target).toBeLessThanOrEqual(250);
    }
  });

  it('核心段（线→点）不超 --mo-track', () => {
    expect(advanceCoreMs(plan)).toBeLessThanOrEqual(MO.track);
  });

  it('触觉与落章同帧（差 ≤50ms 就算同一下）', () => {
    if (!plan || plan.kind !== 'play') throw new Error('该给 play');
    const seal = plan.steps.find((s) => s.target === 'seal');
    expect(seal).toBeDefined();
    expect(Math.abs(plan.hapticAt - seal!.at)).toBeLessThanOrEqual(50);
  });

  it('不播时核心段长度是 0，调用方不用自己判空', () => {
    expect(advanceCoreMs(null)).toBe(0);
    expect(advanceCoreMs({ kind: 'snap' })).toBe(0);
  });
});
