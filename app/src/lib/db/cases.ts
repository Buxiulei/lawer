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
  /** 入职日期 'YYYY-MM-DD'；NULL = 首诊还没填。是 N/2N 年限的计算输入之一 */
  employed_from: string | null;
  /** 月工资（分）；NULL = 还没填。**不存 0 冒充没填**——0 会一路算进赔偿金额 */
  monthly_wage_fen: number | null;
  position: string | null;
  /** 合同签了几次（只签过一次 / 续签过一次 / …），首诊原样记录 */
  contract_count: string | null;
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
  fields: {
    stage?: string;
    goal?: string;
    bottom_line?: string;
    employed_from?: string;
    monthly_wage_fen?: number;
    position?: string;
    contract_count?: string;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of [
    'stage',
    'goal',
    'bottom_line',
    'employed_from',
    'monthly_wage_fen',
    'position',
    'contract_count',
  ] as const) {
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
    /** 调用方自带的幂等键；null = 不带（首诊批量写、站内 agent 都不带） */
    clientRef?: string | null;
  },
): number {
  const info = db
    .prepare(
      'INSERT INTO timeline_events (case_id, happened_at, kind, title, detail, client_ref) VALUES (?, datetime(?), ?, ?, ?, ?)',
    )
    .run(params.caseId, params.happenedAt, params.kind, params.title, params.detail, params.clientRef ?? null);
  return Number(info.lastInsertRowid);
}

/** 按 (case_id, client_ref) 找既有事件；重放同 ref 时回它、不再插第二条。 */
export function findTimelineByClientRef(
  db: Database,
  caseId: number,
  clientRef: string,
): TimelineEventRow | undefined {
  return db
    .prepare(
      'SELECT id, case_id, happened_at, kind, title, detail, milestone, created_at FROM timeline_events WHERE case_id = ? AND client_ref = ? LIMIT 1',
    )
    .get(caseId, clientRef) as TimelineEventRow | undefined;
}

/**
 * 同案 + 同一自然日（date(happened_at)）+ 同 kind 的事件，供近重复守卫在应用层
 * 按标题规范化键比对。**日期在 SQL 里比、标题在 JS 里比**：标题规范化要去中英文标点，
 * SQLite 没有等价的规范化函数，硬用 SQL 会写出与 lib/db/dedup 不一致的第二份判等。
 */
export function listTimelineSameDayKind(
  db: Database,
  caseId: number,
  happenedAt: string,
  kind: string,
): TimelineEventRow[] {
  return db
    .prepare(
      `SELECT id, case_id, happened_at, kind, title, detail, milestone, created_at
         FROM timeline_events
        WHERE case_id = ? AND kind = ? AND date(happened_at) = date(?)`,
    )
    .all(caseId, kind, happenedAt) as TimelineEventRow[];
}

export function listTimelineEvents(db: Database, caseId: number, limit: number): TimelineEventRow[] {
  return db
    .prepare(
      'SELECT id, case_id, happened_at, kind, title, detail, milestone, created_at FROM timeline_events WHERE case_id = ? ORDER BY happened_at DESC, id DESC LIMIT ?',
    )
    .all(caseId, limit) as TimelineEventRow[];
}

/**
 * 时间线的**真总数**与**真最早 1 条**。listTimelineEvents 取的是窗口内最近 N 条，
 * 事实卡的「共 N 条」留痕与「起点锚点」都不能用那个窗口的长度和末行冒充：
 * 45 条事件、窗口 30 时，窗口末行是第 16 条，拿它当入职锚点算工龄会少算一大截，
 * 而「共 30 条」会让模型断言「你只有这 30 件事」。排序口径与 listTimelineEvents 反向对齐。
 */
export function timelineStats(
  db: Database,
  caseId: number,
): { total: number; earliest: TimelineEventRow | null } {
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ?').get(caseId) as { n: number }).n,
  );
  const earliest =
    (db
      .prepare(
        'SELECT id, case_id, happened_at, kind, title, detail, milestone, created_at FROM timeline_events WHERE case_id = ? ORDER BY happened_at ASC, id ASC LIMIT 1',
      )
      .get(caseId) as TimelineEventRow | undefined) ?? null;
  return { total, earliest };
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
