/**
 * 里程碑轨道的三态推导。口径逐条对应 `docs/contracts/case-milestone.md` §五，
 * 两边改动必须同步——那张纸是前后端共用的，这里是它的前端实现。
 *
 * 【临时部分的边界】`DEMO_TRACK` / `DEMO_ATTAINED_BY_EVENT` 是契约定稿前的画布：
 * 后端还没有 `TimelineEvent.milestone` 字段，先在这里手写 demo 事件的落格。
 * 契约落地后**只删这两个常量**，`deriveTrack` 一行不动——
 * 推导逻辑本来就只吃「轨道 + 达成事件」两个入参，不认数据是真是假。
 */

import { demoTimeline } from '@/app/_mock/demo';

/** 与契约 §三 的 `CaseMilestone` 同集合。定稿后从 `_mock/types` 导入，删掉这行。 */
export type Milestone =
  | '协商'
  | '仲裁申请'
  | '立案'
  | '开庭'
  | '裁决'
  | '一审'
  | '二审'
  | '执行';

export type TrackState = '完成' | '进行中' | '跳过' | '未到';

export interface Attainment {
  milestone: Milestone;
  happenedAt: string;
}

export interface TrackCell {
  milestone: Milestone;
  state: TrackState;
  /** 完成才有日期；跳过与未到为 null */
  at: string | null;
}

/**
 * 三态（加「跳过」共四种）推导。
 *
 * 「进行中」取**最新达成事件**而不是「第一个没有事件的格」：后者在真回退上会算错。
 * 撤回仲裁退回协商时，仲裁申请与立案**确实发生过**、事件不能删，
 * 按「第一个没事件的格」会把进行中算到「开庭」，而案子其实回到了谈判桌。
 */
export function deriveTrack(
  track: readonly Milestone[],
  events: readonly Attainment[],
): TrackCell[] {
  const known = new Set(track);
  const valid = events.filter((e) => {
    if (known.has(e.milestone)) return true;
    // 静默丢弃会让「时间轴少一格」没有任何异常信号——同 CALC_FAILED 那次的教训
    console.warn('[milestone] 事件落在轨道之外的里程碑，已忽略：', e.milestone);
    return false;
  });
  const sorted = [...valid].sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));

  const firstAt = new Map<Milestone, string>();
  for (const e of sorted) if (!firstAt.has(e.milestone)) firstAt.set(e.milestone, e.happenedAt);

  const current = currentOf(track, sorted);

  // 「跳过」与「未到」的分界：自己没有达成事件时，看它**后面**有没有
  const lastAttainedIdx = track.reduce(
    (acc, m, i) => (firstAt.has(m) ? i : acc),
    -1,
  );

  return track.map((milestone, i) => {
    if (milestone === current) return { milestone, state: '进行中' as const, at: null };
    const at = firstAt.get(milestone);
    if (at !== undefined) return { milestone, state: '完成' as const, at };
    return {
      milestone,
      state: i < lastAttainedIdx ? ('跳过' as const) : ('未到' as const),
      at: null,
    };
  });
}

/** 「进行中」落在哪一格；全程走完时没有进行中，回 null */
function currentOf(
  track: readonly Milestone[],
  sorted: readonly Attainment[],
): Milestone | null {
  if (sorted.length === 0) return track[0] ?? null;
  const last = sorted[sorted.length - 1];
  // 同一个里程碑出现第二次 ＝ 回退信号，进行中回到它本身
  const repeated = sorted.slice(0, -1).some((e) => e.milestone === last.milestone);
  if (repeated) return last.milestone;
  return track[track.indexOf(last.milestone) + 1] ?? null;
}

// ─────────────────────────────────────────────────────────────
// 【临时画布】契约定稿后整段删除
// ─────────────────────────────────────────────────────────────

/**
 * **全程八段，驾驶舱恒显这一条。**
 *
 * 【显示策略 ≠ 数据层】契约里的 `CaseRecord.milestones` 仍是可变长的，
 * 它记的是**这个案子实际走哪条轨**（数据层的真实进度）。
 * 而驾驶舱**默认就把八段全摆出来**，没走到的用「未到」态占位——
 * 用户要的是「全程陪跑」的视觉承诺（2026-08-29 用户令：一审、二审、强制执行都要在流程里）。
 * **走到了才长出来** 与 **一开始就摆在那** 是两种承诺，他要的是后者。
 */
export const FULL_JOURNEY: readonly Milestone[] = [
  '协商',
  '仲裁申请',
  '立案',
  '开庭',
  '裁决',
  '一审',
  '二审',
  '执行',
];

/** demo 案件**数据层**走的轨（仲裁轨五段）。显示仍走 FULL_JOURNEY。 */
export const DEMO_TRACK: readonly Milestone[] = [
  '协商',
  '仲裁申请',
  '立案',
  '开庭',
  '裁决',
];

/**
 * demo 事件里哪一条构成达成，按契约 §四 写入授权表手判。
 * `te_18`＝「收到《解除劳动合同通知书》」＝协商终局（公司单方解除，谈判到此结束）。
 */
const DEMO_ATTAINED_BY_EVENT: Record<string, Milestone> = { te_18: '协商' };

export function demoAttainments(): Attainment[] {
  return demoTimeline
    .filter((e) => e.id in DEMO_ATTAINED_BY_EVENT)
    .map((e) => ({ milestone: DEMO_ATTAINED_BY_EVENT[e.id], happenedAt: e.happenedAt }));
}
