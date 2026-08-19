// app/src/lib/cases/index.ts
// 案件档案的领域逻辑：枚举校验 + **归属校验**（spec §6 lib/cases）。
//
// 【红线】任何按 case_id 的读写，第一步都是 assertOwned：case.user_id !== uid 一律当作
// "不存在"（CASE_NOT_FOUND），不返回 403。理由：403 等于告诉对方"这个案件号是有效的、
// 只是不属于你"，攻击者可以靠遍历 id 数出平台有多少案件、哪些 id 被占用。
// 案件里是解除通知、工资流水、录音——泄漏边界必须按"连存在性都不承认"来划。
//
// 本文件不写 SQL，全部经 lib/db/cases.ts（spec §3.2）。
import type { Database } from 'better-sqlite3';

import * as store from '@/lib/db/cases';

/** 与 migrate.ts cases.stage 注释逐字对齐 */
export const CASE_STAGES = [
  '风声',
  '约谈中',
  '已收通知',
  '已解除',
  '仲裁准备',
  '已立案',
  '开庭',
  '裁决',
  '一审',
  '二审',
  '执行',
  '结案',
] as const;

/** 与 migrate.ts timeline_events.kind 注释逐字对齐 */
export const TIMELINE_KINDS = ['公司动作', '我方动作', '系统动作', '期限'] as const;

/** 与 migrate.ts action_items.status 注释逐字对齐 */
export const ACTION_STATUSES = ['待办', '完成', '放弃'] as const;

/** case_get 一次最多带回多少条时间线事件（spec §3.5 列表全部分页） */
const TIMELINE_DEFAULT_LIMIT = 50;
const TIMELINE_MAX_LIMIT = 200;

export interface DomainFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

export type Result<T> = ({ ok: true } & T) | DomainFailure;

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

const NOT_FOUND = () => fail(404, 'CASE_NOT_FOUND', '案件不存在');

/**
 * 归属校验。不是自己的案件与不存在的案件返回**同一个**错误，调用方无从分辨。
 * 所有对外入口都必须先过这里。
 */
function assertOwned(db: Database, caseId: number, userId: number): store.CaseRow | DomainFailure {
  if (!Number.isInteger(caseId) || caseId <= 0) return NOT_FOUND();
  const row = store.findCaseById(db, caseId);
  if (!row || row.user_id !== userId) return NOT_FOUND();
  return row;
}

function isFailure(value: unknown): value is DomainFailure {
  return typeof value === 'object' && value !== null && (value as DomainFailure).ok === false;
}

/** 取非空字符串；不是字符串或去空白后为空则返回 null */
function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 校验 ISO8601 时间串，返回归一化后的 UTC ISO 串；不合法返回 null */
function normalizeIsoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ========== 读 ==========

/** 案件详情 + 最近若干条时间线（时间线没有独立的读工具，档案本身就该带着它） */
export function getCase(
  db: Database,
  input: { caseId: number; userId: number; timelineLimit?: number },
): Result<{ case: store.CaseRow; timeline: store.TimelineEventRow[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  // 没传、传了负数或垃圾值 → 回默认；传了合法值 → 封顶到 MAX。
  // 不把非法值夹成 1，那样调用方写错参数只会拿到一条记录，比直接回默认更难察觉。
  const requested = Math.trunc(Number(input.timelineLimit ?? TIMELINE_DEFAULT_LIMIT));
  const limit =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(requested, TIMELINE_MAX_LIMIT)
      : TIMELINE_DEFAULT_LIMIT;
  return { ok: true, case: found, timeline: store.listTimelineEvents(db, input.caseId, limit) };
}

export function listActions(
  db: Database,
  input: { caseId: number; userId: number; status?: string },
): Result<{ actions: store.ActionItemRow[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const status = input.status ?? null;
  if (status !== null && !(ACTION_STATUSES as readonly string[]).includes(status)) {
    return fail(400, 'INVALID_STATUS', `status 只能是 ${ACTION_STATUSES.join(' / ')}`);
  }
  return { ok: true, actions: store.listActionItems(db, input.caseId, status) };
}

export function listDeadlines(
  db: Database,
  input: { caseId: number; userId: number; includeResolved?: boolean },
): Result<{ deadlines: store.DeadlineRow[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;
  return {
    ok: true,
    deadlines: store.listDeadlines(db, input.caseId, input.includeResolved === true),
  };
}

export function listEvidence(
  db: Database,
  input: { caseId: number; userId: number },
): Result<{ evidence: store.EvidenceRow[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;
  return { ok: true, evidence: store.listEvidence(db, input.caseId) };
}

// ========== 写 ==========

/**
 * 改案件的 stage / goal / bottom_line。
 * 只开放这三个字段：title/district/status 的改动牵扯期限重算与档案一致性，等相应窗口定。
 */
export function updateCase(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    stage?: unknown;
    goal?: unknown;
    bottomLine?: unknown;
  },
): Result<{ case: store.CaseRow }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const fields: { stage?: string; goal?: string; bottom_line?: string } = {};
  if (input.stage !== undefined) {
    if (typeof input.stage !== 'string' || !(CASE_STAGES as readonly string[]).includes(input.stage)) {
      return fail(400, 'INVALID_STAGE', `stage 只能是 ${CASE_STAGES.join(' / ')}`);
    }
    fields.stage = input.stage;
  }
  if (input.goal !== undefined) {
    const goal = trimmedOrNull(input.goal);
    if (goal === null) return fail(400, 'INVALID_GOAL', 'goal 不能为空字符串');
    fields.goal = goal;
  }
  if (input.bottomLine !== undefined) {
    const bottomLine = trimmedOrNull(input.bottomLine);
    if (bottomLine === null) return fail(400, 'INVALID_BOTTOM_LINE', 'bottom_line 不能为空字符串');
    fields.bottom_line = bottomLine;
  }
  if (Object.keys(fields).length === 0) {
    return fail(400, 'NO_FIELDS', '至少要改一个字段：stage / goal / bottom_line');
  }

  store.updateCaseFields(db, input.caseId, fields);
  return { ok: true, case: store.findCaseById(db, input.caseId)! };
}

/** 加一条时间线事件。只追加，写错了补一条新的（spec §7），本模块不提供改/删。 */
export function addTimelineEvent(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    happenedAt: unknown;
    kind: unknown;
    title: unknown;
    detail?: unknown;
    now?: Date;
  },
): Result<{ event: store.TimelineEventRow }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const happenedAt = normalizeIsoTime(input.happenedAt);
  if (!happenedAt) {
    return fail(400, 'INVALID_HAPPENED_AT', 'happened_at 必须是 ISO8601 时间串');
  }
  if (typeof input.kind !== 'string' || !(TIMELINE_KINDS as readonly string[]).includes(input.kind)) {
    return fail(400, 'INVALID_KIND', `kind 只能是 ${TIMELINE_KINDS.join(' / ')}`);
  }
  const title = trimmedOrNull(input.title);
  if (!title) return fail(400, 'INVALID_TITLE', 'title 不能为空');

  const id = store.insertTimelineEvent(db, {
    caseId: input.caseId,
    happenedAt,
    kind: input.kind,
    title,
    detail: trimmedOrNull(input.detail),
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  const event = store.listTimelineEvents(db, input.caseId, TIMELINE_MAX_LIMIT).find((e) => e.id === id)!;
  return { ok: true, event };
}

/** 把一条行动卡标成「完成」（或「放弃」）。action 必须属于本案，本案必须属于本人。 */
export function setActionStatus(
  db: Database,
  input: { caseId: number; userId: number; actionId: number; status?: unknown },
): Result<{ action: store.ActionItemRow }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const status = input.status === undefined ? '完成' : input.status;
  if (typeof status !== 'string' || !(ACTION_STATUSES as readonly string[]).includes(status)) {
    return fail(400, 'INVALID_STATUS', `status 只能是 ${ACTION_STATUSES.join(' / ')}`);
  }

  const action = store.findActionItem(db, input.actionId);
  // 行动卡不属于本案 → 同样按"不存在"处理，不泄漏它在别的案件下存在
  if (!action || action.case_id !== input.caseId) {
    return fail(404, 'ACTION_NOT_FOUND', '行动项不存在');
  }

  store.updateActionStatus(db, input.actionId, status);
  return { ok: true, action: { ...action, status } };
}
