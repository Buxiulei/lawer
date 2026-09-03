/**
 * 「这个案件是不是刚建好、里面还什么都没有」——**全站唯一的判据**。
 *
 * 【立这个函数的由头（F-201）】老用户（名下有案件、4 条对话、1 份证据）退出重登，
 * 落在 /welcome 上看到的是整屏「档案已创建 … 接下来花几分钟做一次首诊」，
 * 唯一的 CTA 是「开始首诊」。数据一条没少，只是这一屏**从没问过**他是不是新人。
 * 一个刚被裁、正等仲裁的人读到"你的档案刚建好"，第一反应是"我讲过的东西没了"。
 *
 * 【为什么要四个维度，而不是"有没有案件"】案件是注册那一刻就建的
 * （lib/cases 的 ensureDefaultCase），人人都有——拿它判新老，人人都是老用户。
 * 也不能只看时间线：首诊只填了工资和司龄、一句话都没聊的人，时间线可能是空的，
 * 而他的首诊四列是满的。**任一维度有东西就不是新人**，方向只能往这边错：
 * 把老用户当新人，是让他重讲一遍被裁的经过；把新人当老用户，只是一颗按钮点过去发现是空的。
 *
 * 判据见 app/welcome/__tests__/welcome-states.test.tsx。
 */

/** 首诊那四列（lib/db/cases 的 CaseRow 上标着「NULL = 首诊还没填」的那四个）。 */
export interface IntakeColumns {
  /** 入职日期 'YYYY-MM-DD' */
  employedFrom: string | null;
  /** 月工资（分）。**0 不算没填**——库里刻意不存 0 冒充空 */
  monthlyWageFen: number | null;
  position: string | null;
  /** 合同签了几次 */
  contractCount: string | null;
}

export interface CaseSnapshot {
  timelineCount: number;
  messageCount: number;
  evidenceCount: number;
  intake: IntakeColumns;
}

/** 一列填过没有。空串按没填算：首诊跳过某一格时存的可能是空串而不是 NULL。 */
function filled(value: string | number | null): boolean {
  if (value === null) return false;
  return typeof value === 'string' ? value.trim() !== '' : true;
}

/** 首诊四列一格都没填 */
export function intakeUntouched(intake: IntakeColumns): boolean {
  return (
    !filled(intake.employedFrom) &&
    !filled(intake.monthlyWageFen) &&
    !filled(intake.position) &&
    !filled(intake.contractCount)
  );
}

/** 四个维度全空才算「还是新的」。任何一个维度有东西，这人就不是第一次来。 */
export function isFreshCase(snapshot: CaseSnapshot): boolean {
  return (
    snapshot.timelineCount === 0 &&
    snapshot.messageCount === 0 &&
    snapshot.evidenceCount === 0 &&
    intakeUntouched(snapshot.intake)
  );
}
