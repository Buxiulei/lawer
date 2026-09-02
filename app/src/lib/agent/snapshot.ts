// app/src/lib/agent/snapshot.ts
// 案件档案快照：一次性把「回这一轮话需要知道的全部档案事实」从库里取出来，
// 之后的 system prompt 组装（prompt.ts）与问诊状态推断（intake.ts）都只吃这个快照，
// 不再各自查库。这样状态机是纯函数、可单测，也不会出现「prompt 里写的和状态机以为的不一致」。
import type { Database } from 'better-sqlite3';

import { decryptField } from '@/lib/crypto';
import * as agentStore from '@/lib/db/agent';
import * as caseStore from '@/lib/db/cases';

/** 时间线取最近多少条进上下文。再多会把 system prompt 撑爆，且陈年事件对「现在做什么」无贡献。 */
const TIMELINE_WINDOW = 30;
/** 前情提要用：最近完成/放弃的行动卡取几条 */
const RECENT_CLOSED_ACTIONS = 5;

/**
 * 当事人身份。**姓名进 system prompt 是 manager 2026-09-02 拍的板（方案 A）**：
 * 不给姓名，agent 就永远填不了仲裁申请书，而它上一次的做法是留一个占位符再宣称"已用真实姓名"。
 * 代价是每轮把明文姓名发给模型提供方——所以事实卡里紧跟一条使用约束（只用于文书、正文不复述）。
 */
export interface CaseIdentity {
  /** 解密后的真实姓名。只有 authStatus === '已实名' 且密文解得开时才非 null */
  realName: string | null;
  /** users.auth_status：未认证 | 待审 | 已实名 */
  authStatus: string;
  /**
   * 有密文但解不开（缺 LAWER_DATA_KEY / 密钥换过 / 密文被改）。
   * 单独一个标志而不是并进 realName=null：**"没实名"和"读不出来"要说不同的话**——
   * 前者该让用户去实名，后者是我们自己的故障，含糊成同一句会把运维问题说成用户问题。
   */
  nameUnreadable: boolean;
}

export interface CaseSnapshot {
  case: caseStore.CaseRow;
  /** 当事人是谁（users 表 + 解密）。此前 agent 全链路从不查 users，所以"没有姓名"连它自己都不知道 */
  identity: CaseIdentity;
  /** 证据元数据（只有文件名/类别/证明目的/状态，没有文件内容——全站无 OCR 接线） */
  evidence: caseStore.EvidenceRow[];
  /** 本案历史消息的总量与最早时间。给事实卡说"我只看得到最近一段"用，不是摘要 */
  historyStats: { total: number; firstAt: string | null };
  /** 窗口内最近 TIMELINE_WINDOW 条（倒序，最新在前） */
  timeline: caseStore.TimelineEventRow[];
  /**
   * 时间线的真总数与真最早 1 条。**不能从 timeline 推**：窗口先截过一刀，
   * 窗口长度冒充总数会让模型以为「一共就这 30 件事」，窗口末行冒充入职锚点会算错工龄。
   */
  timelineStats: { total: number; earliest: caseStore.TimelineEventRow | null };
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
    identity: loadIdentity(db, row.user_id),
    evidence: caseStore.listEvidence(db, caseId),
    historyStats: agentStore.countCaseMessages(db, caseId),
    timeline,
    timelineStats: caseStore.timelineStats(db, caseId),
    claims: agentStore.listClaims(db, caseId),
    companies: agentStore.listCompanyProfiles(db, caseId),
    openActions: allActions.filter((a) => a.status === '待办'),
    closedActions: allActions.filter((a) => a.status !== '待办').slice(-RECENT_CLOSED_ACTIONS),
    deadlines: caseStore.listDeadlines(db, caseId, false),
    storedIntakeStage: agentStore.readIntakeStage(db, caseId),
    referredNbdpsy: agentStore.hasReferredNbdpsy(db, caseId),
  };
}

/**
 * 取当事人姓名。解密失败**不抛**：这条路在每一轮对话的必经之处，
 * 密钥没配对就让整个案子聊不了天，代价远大于这一轮少一个姓名。
 * 失败时如实标 nameUnreadable，由事实卡说出"这是我们的故障"。
 */
function loadIdentity(db: Database, userId: number): CaseIdentity {
  const row = agentStore.findUserIdentity(db, userId);
  if (!row) return { realName: null, authStatus: '未认证', nameUnreadable: false };
  if (row.auth_status !== '已实名' || !row.real_name_enc) {
    return { realName: null, authStatus: row.auth_status, nameUnreadable: false };
  }
  try {
    return { realName: decryptField(row.real_name_enc), authStatus: row.auth_status, nameUnreadable: false };
  } catch {
    return { realName: null, authStatus: row.auth_status, nameUnreadable: true };
  }
}
