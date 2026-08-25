// app/src/lib/agent/snapshot.ts
// 案件档案快照：一次性把「回这一轮话需要知道的全部档案事实」从库里取出来，
// 之后的 system prompt 组装（prompt.ts）与问诊状态推断（intake.ts）都只吃这个快照，
// 不再各自查库。这样状态机是纯函数、可单测，也不会出现「prompt 里写的和状态机以为的不一致」。
import type { Database } from 'better-sqlite3';

import * as agentStore from '@/lib/db/agent';
import * as caseStore from '@/lib/db/cases';

/** 时间线取最近多少条进上下文。再多会把 system prompt 撑爆，且陈年事件对「现在做什么」无贡献。 */
const TIMELINE_WINDOW = 30;
/** 前情提要用：最近完成/放弃的行动卡取几条 */
const RECENT_CLOSED_ACTIONS = 5;

export interface CaseSnapshot {
  case: caseStore.CaseRow;
  timeline: caseStore.TimelineEventRow[];
  claims: agentStore.ClaimRow[];
  companies: agentStore.CompanyProfileRow[];
  /** 未完成的行动卡：charter §9「每次给出的行动卡要在下轮跟踪」的输入 */
  openActions: caseStore.ActionItemRow[];
  /** 最近已完成/放弃的行动卡，供陪跑开场的前情提要说「上次那三件做了两件」 */
  closedActions: caseStore.ActionItemRow[];
  deadlines: caseStore.DeadlineRow[];
  /**
   * threads.intake_stage 落痕（migrate.ts 存量迁移区）。null = 还没落过。
   * A/B/C 由档案推导，本值只在「D 档特殊保护问过了吗」这件档案推不出来的事上说了算。
   */
  storedIntakeStage: string | null;
  /** 本案是否已转介过 NBDpsy。spec §10：一案最多一次 */
  referredNbdpsy: boolean;
}

export function loadCaseSnapshot(db: Database, caseId: number): CaseSnapshot {
  const row = caseStore.findCaseById(db, caseId);
  if (!row) throw new Error(`案件 ${caseId} 不存在（调用方应先过 lib/cases 的归属校验）`);

  const timeline = caseStore.listTimelineEvents(db, caseId, TIMELINE_WINDOW);
  const allActions = caseStore.listActionItems(db, caseId, null);

  return {
    case: row,
    timeline,
    claims: agentStore.listClaims(db, caseId),
    companies: agentStore.listCompanyProfiles(db, caseId),
    openActions: allActions.filter((a) => a.status === '待办'),
    closedActions: allActions.filter((a) => a.status !== '待办').slice(-RECENT_CLOSED_ACTIONS),
    deadlines: caseStore.listDeadlines(db, caseId, false),
    storedIntakeStage: agentStore.readIntakeStage(db, caseId),
    referredNbdpsy: agentStore.hasReferredNbdpsy(db, caseId),
  };
}
