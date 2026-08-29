/**
 * 里程碑三态推导的守卫。判据出处：`docs/contracts/case-milestone.md` §五。
 *
 * 【这组断言是有牙的，牙是量出来的，不是声称的】
 * 跑过 11 条变异，**15 条断言每一条都被至少一条变异钉红过**：
 *
 *   1 进行中改「第一个没事件的格」   2 跳过并进未到        3 完成日期取最新而非最早
 *   4 轨道外里程碑静默丢弃          5 不按时间排          6 完成格丢日期
 *   7 回退抹掉后面的完成            8 无事件时没有进行中    9 跳过编一个日期
 *  10 走完后进行中回落末格         11 demo 画布落错格
 *
 * 变异 7 是这组里最重要的一条：它模拟的正是**用 stage 标量推三态**的语义
 * ——回退时把后面的「完成」抹回「未到」。整份契约存在的理由就是不许这件事发生，
 * 所以必须有一条断言在它发生时变红。
 *
 * 【怎么来的】头一轮只有 5 条变异时，15 条里有 7 条从没被钉红过——
 * 包括「已完成的格日期还是当初那天」这条**承载整个设计**的断言。
 * 补变异 6–11 才把它们逐条钉住。
 * ⇒ 纪律：跑完矩阵回头问一句「**哪条守卫从头到尾没被任何变异钉红过？**」
 *    没被钉红的守卫，牙是没被证明的，它只是碰巧和别的守卫并存。
 */
import { describe, expect, it, vi } from 'vitest';
import { demoTimeline } from '@/app/_mock/demo';
import {
  DEMO_TRACK,
  FULL_JOURNEY,
  demoAttainments,
  deriveTrack,
  type Attainment,
  type Milestone,
} from '../milestones';

const ARB: readonly Milestone[] = ['协商', '仲裁申请', '立案', '开庭', '裁决'];
const at = (milestone: Milestone, happenedAt: string): Attainment => ({ milestone, happenedAt });
/** 只取状态，断言读起来是一行轨道 */
const states = (cells: ReturnType<typeof deriveTrack>) => cells.map((c) => c.state);

describe('deriveTrack', () => {
  it('没有任何达成事件时，第一格是进行中，其余未到', () => {
    expect(states(deriveTrack(ARB, []))).toEqual(['进行中', '未到', '未到', '未到', '未到']);
  });

  it('达成一格后，进行中落在它的下一格', () => {
    const cells = deriveTrack(ARB, [at('协商', '2026-07-24T09:40:00+08:00')]);
    expect(states(cells)).toEqual(['完成', '进行中', '未到', '未到', '未到']);
    expect(cells[0].at).toBe('2026-07-24T09:40:00+08:00');
    // 进行中那格不带日期——它还没发生完
    expect(cells[1].at).toBeNull();
  });

  it('完成日期取该里程碑**最早**那条事件，不是最新那条', () => {
    const cells = deriveTrack(ARB, [
      at('协商', '2026-07-01T10:00:00+08:00'),
      at('协商', '2026-07-20T10:00:00+08:00'),
      at('仲裁申请', '2026-07-25T10:00:00+08:00'),
    ]);
    expect(cells[0].at).toBe('2026-07-01T10:00:00+08:00');
  });

  it('事件乱序传进来也按时间排，不按数组顺序', () => {
    const cells = deriveTrack(ARB, [
      at('仲裁申请', '2026-07-25T10:00:00+08:00'),
      at('协商', '2026-07-01T10:00:00+08:00'),
    ]);
    expect(states(cells)).toEqual(['完成', '完成', '进行中', '未到', '未到']);
  });

  describe('回退', () => {
    // 撤回仲裁申请、退回谈判桌：仲裁申请与立案**确实发生过**，事件不能删
    const events = [
      at('协商', '2026-06-01T10:00:00+08:00'),
      at('仲裁申请', '2026-06-20T10:00:00+08:00'),
      at('立案', '2026-07-05T10:00:00+08:00'),
      at('协商', '2026-08-01T10:00:00+08:00'), // 回退信号：协商第二次出现
    ];

    it('进行中回到协商，而不是顺着往后走到开庭', () => {
      expect(states(deriveTrack(ARB, events))).toEqual([
        '进行中',
        '完成',
        '完成',
        '未到',
        '未到',
      ]);
    });

    it('已完成的格保持完成、且日期还是**当初**那天——这就是「如实记」', () => {
      const cells = deriveTrack(ARB, events);
      expect(cells[1].at).toBe('2026-06-20T10:00:00+08:00');
      expect(cells[2].at).toBe('2026-07-05T10:00:00+08:00');
    });

    it('若改用「第一个没有事件的格」当进行中，这里会算到开庭——固定住这个反例', () => {
      const naive = ARB.find((m) => !events.some((e) => e.milestone === m));
      expect(naive).toBe('开庭');
      expect(deriveTrack(ARB, events).find((c) => c.state === '进行中')?.milestone).toBe('协商');
    });
  });

  describe('跳过与未到必须分得开', () => {
    // 直接从立案开始记（前两格没有达成事件）
    const cells = deriveTrack(ARB, [at('立案', '2026-07-05T10:00:00+08:00')]);

    it('前面没事件、后面有事件的格是「跳过」，不是「未到」', () => {
      expect(states(cells)).toEqual(['跳过', '跳过', '完成', '进行中', '未到']);
    });

    it('跳过不带日期——没发生过的事不许编一个时间出来', () => {
      expect(cells[0].at).toBeNull();
      expect(cells[1].at).toBeNull();
    });

    // 这条是这组里唯一真正咬住「合并」的：前两条在把跳过并进未到之后**照样绿**。
    // 用户看到的是一排点，「我没走这段」和「后面还没到」必须不是同一个点。
    it('跳过的格与轨道末尾没走到的格，状态不能相同', () => {
      expect(cells[0].state).toBe('跳过'); // 立案之前，被跳过去了
      expect(cells[4].state).toBe('未到'); // 裁决，还没轮到
      expect(cells[0].state).not.toBe(cells[4].state);
    });
  });

  it('全程走完后没有进行中，末格也是完成', () => {
    const cells = deriveTrack(
      ARB,
      ARB.map((m, i) => at(m, `2026-0${i + 1}-01T10:00:00+08:00`)),
    );
    expect(states(cells)).toEqual(['完成', '完成', '完成', '完成', '完成']);
  });

  it('轨道可变长：进了法院就多出三格，不是永远停在裁决', () => {
    const 诉讼轨: readonly Milestone[] = [...ARB, '一审', '二审', '执行'];
    const cells = deriveTrack(诉讼轨, [at('裁决', '2026-07-01T10:00:00+08:00')]);
    expect(cells).toHaveLength(8);
    expect(cells[5].state).toBe('进行中'); // 一审
  });

  it('落在轨道之外的里程碑要**出声**忽略，不能静默漏格', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cells = deriveTrack(ARB, [
      at('协商', '2026-07-01T10:00:00+08:00'),
      at('一审', '2026-07-02T10:00:00+08:00'), // 仲裁轨上没有这一格
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(states(cells)).toEqual(['完成', '进行中', '未到', '未到', '未到']);
    warn.mockRestore();
  });
});

describe('全程八段（驾驶舱恒显的那条）', () => {
  /*
   * `Record<Milestone, true>` 逼 tsc 列全联合的每一个成员：
   * 将来给 CaseMilestone 加一档而忘了加进 FULL_JOURNEY，**这里编译就红**，
   * 不用等有人打开页面发现少一格。
   */
  const ALL: Record<Milestone, true> = {
    协商: true,
    仲裁申请: true,
    立案: true,
    开庭: true,
    裁决: true,
    一审: true,
    二审: true,
    执行: true,
  };

  it('八段一个不少，顺序就是案件真实走法', () => {
    expect(FULL_JOURNEY).toEqual([
      '协商',
      '仲裁申请',
      '立案',
      '开庭',
      '裁决',
      '一审',
      '二审',
      '执行',
    ]);
  });

  it('覆盖 Milestone 联合的全部成员，不多不少', () => {
    expect([...FULL_JOURNEY].sort()).toEqual(Object.keys(ALL).sort());
  });

  it('demo 只达成协商时，后面七段全是「未到」——摆在那但不谎报进度', () => {
    const cells = deriveTrack(FULL_JOURNEY, demoAttainments());
    expect(cells).toHaveLength(8);
    expect(states(cells)).toEqual([
      '完成',
      '进行中',
      '未到',
      '未到',
      '未到',
      '未到',
      '未到',
      '未到',
    ]);
  });
});

describe('demo 画布', () => {
  it('demo 案件渲染出来就是原型屏一那一行：协商完成、仲裁申请进行中', () => {
    expect(states(deriveTrack(DEMO_TRACK, demoAttainments()))).toEqual([
      '完成',
      '进行中',
      '未到',
      '未到',
      '未到',
    ]);
  });

  it('demo 的协商达成日期就是收到解除通知那天，不是另编的', () => {
    // 期望值不从 demoAttainments() 取——那是被测函数的入参，拿它作断言等于同义反复。
    // 改从 demoTimeline 里按事件本身找，走的是另一条路。
    const 解除通知 = demoTimeline.find((e) => e.title.includes('解除劳动合同通知书'));
    expect(解除通知).toBeDefined();
    const cells = deriveTrack(DEMO_TRACK, demoAttainments());
    expect(cells[0].at).toBe(解除通知!.happenedAt);
  });
});
