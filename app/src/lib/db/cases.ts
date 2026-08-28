// app/src/lib/db/cases.ts
// cases / timeline_events / action_items / deadlines / evidence 五张表的封装
// （spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 这一层不做归属校验，只忠实读写；"这个案件是不是这个用户的"由 lib/cases 把关。
// 但凡按 case 取子表的函数都要求调用方先过 lib/cases 的归属校验。
import type { Database } from 'better-sqlite3';

export interface CaseRow {
  id: number;
  user_id: number;
  title: string;
  stage: string;
  district: string;
  goal: string | null;
  bottom_line: string | null;
  status: string;
  created_at: string;
}

export interface TimelineEventRow {
  id: number;
  case_id: number;
  happened_at: string;
  kind: string;
  title: string;
  detail: string | null;
  /** 达成的里程碑（批 6 驾驶舱）。null = 这条事件不构成任何里程碑，绝大多数事件都是 null。 */
  milestone: string | null;
  created_at: string;
}

export interface ActionItemRow {
  id: number;
  case_id: number;
  title: string;
  detail: string | null;
  due_at: string | null;
  priority: number;
  status: string;
  created_at: string;
}

export interface DeadlineRow {
  id: number;
  case_id: number;
  kind: string;
  due_at: string;
  derived_from: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface EvidenceRow {
  id: number;
  case_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  status: string;
  created_at: string;
}

// ========== cases ==========

/**
 * 建一个新案件。stage（风声）与 district（朝阳）取 DDL 默认值，不在这里再写一份——
 * 默认值只该有一个出处，两处各写一遍迟早会不一致。
 */
export function insertCase(db: Database, params: { userId: number; title: string }): number {
  const info = db
    .prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)')
    .run(params.userId, params.title);
  return Number(info.lastInsertRowid);
}

export function findCaseById(db: Database, caseId: number): CaseRow | undefined {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as CaseRow | undefined;
}

export function listCasesByUser(db: Database, userId: number): CaseRow[] {
  return db
    .prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY id DESC')
    .all(userId) as CaseRow[];
}

/**
 * 按字段名部分更新。字段名来自本文件写死的白名单（调用方只能传 lib/cases 校验过的键），
 * 不接受任意字符串拼进 SQL。
 */
export function updateCaseFields(
  db: Database,
  caseId: number,
  fields: { stage?: string; goal?: string; bottom_line?: string },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of ['stage', 'goal', 'bottom_line'] as const) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(caseId);
  db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

// ========== timeline_events ==========

/**
 * 只追加，修正靠补一条新事件（spec §7）——本文件不提供 update/delete。
 *
 * 时间列按 ADR-002 走 canonical 格式：created_at 交给列 DEFAULT；
 * happened_at 是 API 传进来的 ISO8601，用 SQLite 的 datetime() 就地归一成空格格式，
 * 这样它和库里其它时间列可以直接做字符串比较与排序（idx 也还走得上）。
 */
export function insertTimelineEvent(
  db: Database,
  params: {
    caseId: number;
    /** ISO8601，落库前由 datetime() 归一 */
    happenedAt: string;
    kind: string;
    title: string;
    detail: string | null;
  },
): number {
  const info = db
    .prepare(
      'INSERT INTO timeline_events (case_id, happened_at, kind, title, detail) VALUES (?, datetime(?), ?, ?, ?)',
    )
    .run(params.caseId, params.happenedAt, params.kind, params.title, params.detail);
  return Number(info.lastInsertRowid);
}

export function listTimelineEvents(db: Database, caseId: number, limit: number): TimelineEventRow[] {
  return db
    .prepare(
      'SELECT id, case_id, happened_at, kind, title, detail, milestone, created_at FROM timeline_events WHERE case_id = ? ORDER BY happened_at DESC, id DESC LIMIT ?',
    )
    .all(caseId, limit) as TimelineEventRow[];
}

/**
 * 给一条已存在的事件盖上里程碑。**全仓写 milestone 列的 SQL 只有这一条。**
 *
 * 【为什么不做成 insertTimelineEvent 的一个参数】契约 §六·二：通用写路径**在类型上就不该
 * 设得了这个字段**，否则"无确认不写"只是一条纪律——纪律要靠人记得，入口不存在则不需要记。
 * 现在 `insertTimelineEvent` 的 params 里没有 milestone，任何走通用路径落的行该列恒为 NULL，
 * 这一点由守卫测试在运行时验，不是靠读类型推。
 *
 * 【为什么带 caseId 而不只按 eventId】跨案件盖章要挡住：调用方即使拿到别人案子的
 * event_id，WHERE 里的 case_id 也会让它落空（归属校验仍在 lib/cases 那层先做一遍）。
 *
 * @returns 是否真的更新到一行（false = 事件不存在或不属于该案）
 */
export function setEventMilestone(
  db: Database,
  params: { caseId: number; eventId: number; milestone: string },
): boolean {
  const info = db
    .prepare('UPDATE timeline_events SET milestone = ? WHERE id = ? AND case_id = ?')
    .run(params.milestone, params.eventId, params.caseId);
  return info.changes > 0;
}

// ========== action_items ==========

export function listActionItems(
  db: Database,
  caseId: number,
  status: string | null,
): ActionItemRow[] {
  const sql =
    'SELECT id, case_id, title, detail, due_at, priority, status, created_at FROM action_items WHERE case_id = ?';
  return status === null
    ? (db.prepare(`${sql} ORDER BY priority DESC, id`).all(caseId) as ActionItemRow[])
    : (db
        .prepare(`${sql} AND status = ? ORDER BY priority DESC, id`)
        .all(caseId, status) as ActionItemRow[]);
}

export function findActionItem(db: Database, actionId: number): ActionItemRow | undefined {
  return db.prepare('SELECT * FROM action_items WHERE id = ?').get(actionId) as
    | ActionItemRow
    | undefined;
}

export function updateActionStatus(db: Database, actionId: number, status: string): void {
  db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, actionId);
}

// ========== deadlines ==========

/** 默认只列生效中的（resolved_at IS NULL），这正是 idx_deadlines_due 的部分索引条件 */
export function listDeadlines(db: Database, caseId: number, includeResolved: boolean): DeadlineRow[] {
  const sql =
    'SELECT id, case_id, kind, due_at, derived_from, resolved_at, created_at FROM deadlines WHERE case_id = ?';
  return includeResolved
    ? (db.prepare(`${sql} ORDER BY due_at`).all(caseId) as DeadlineRow[])
    : (db.prepare(`${sql} AND resolved_at IS NULL ORDER BY due_at`).all(caseId) as DeadlineRow[]);
}

// ========== evidence ==========

export function listEvidence(db: Database, caseId: number): EvidenceRow[] {
  return db
    .prepare(
      'SELECT id, case_id, name, category, prove_purpose, status, created_at FROM evidence WHERE case_id = ? ORDER BY id DESC',
    )
    .all(caseId) as EvidenceRow[];
}
