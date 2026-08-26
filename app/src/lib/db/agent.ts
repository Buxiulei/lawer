// app/src/lib/db/agent.ts
// 律师 agent 用到的会话与档案写入表封装：threads / messages / claims / action_items /
// emotion_log / company_profiles / drafts（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 与 cases.ts 的分工：cases.ts 是「用户在网页/MCP 上读写档案」那一路，本文件是「agent 在对话中
// 回写档案」那一路，两边落的是同一批表。不合并成一个文件，是因为归属校验的入口不同——
// cases.ts 的每个函数背后都有 lib/cases 的 assertOwned 把关，本文件的调用方是 lib/agent，
// 由 lib/agent 在进编排循环**之前**一次性校验案件归属（工具调用不带 case_id，case_id 由
// 服务端注入，模型无从越权到别人的案子）。
//
// 时间列一律走 ADR-002：created_at/updated_at 交给列 DEFAULT 或 datetime('now')，
// 外部传入的 ISO8601 用 SQLite 的 datetime() 就地归一，应用层不拼时间串。
import type { Database } from 'better-sqlite3';

export interface ThreadRow {
  id: number;
  case_id: number;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  role: string;
  content: string | null;
  model: string | null;
  tokens_json: string | null;
  created_at: string;
}

export interface ClaimRow {
  id: number;
  case_id: number;
  kind: string;
  amount_fen: number;
  calc_json: string | null;
  basis: string | null;
  status: string;
  created_at: string;
}

export interface CompanyProfileRow {
  id: number;
  case_id: number;
  name: string;
  uscc: string | null;
  role: string;
  legal_rep: string | null;
  risk_notes: string | null;
  sources_json: string | null;
  created_at: string;
}

export interface DraftRow {
  id: number;
  case_id: number;
  kind: string;
  title: string;
  content: string | null;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
}

// ========== threads / messages ==========

/**
 * 取该案件该模式下最近的一条会话，没有就开一条。
 *
 * 一案一模式复用同一 thread（而不是每次请求开新的）：陪跑是长期关系，
 * 用户明天回来接着聊的还是同一件事，会话切碎了「上次待办完成没有」就无从谈起。
 * 需要另起炉灶的场景（换公司/换案子）走的是新 case，不是新 thread。
 */
export function ensureThread(db: Database, caseId: number, mode: string): ThreadRow {
  const found = db
    .prepare('SELECT * FROM threads WHERE case_id = ? AND mode = ? ORDER BY id DESC LIMIT 1')
    .get(caseId, mode) as ThreadRow | undefined;
  if (found) return found;
  const id = Number(
    db.prepare('INSERT INTO threads (case_id, mode) VALUES (?, ?)').run(caseId, mode).lastInsertRowid,
  );
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow;
}

/**
 * 问诊状态机进度落痕（threads.intake_stage，migrate.ts 存量迁移区）。
 *
 * 状态机本身是**推导式**的（A/B/C 从档案算出来，见 lib/agent/intake），本列只是落痕：
 * 它解决的是「D 档特殊保护情形问过了吗」这个档案里推不出来的事——
 * 用户答「我没怀孕也没工伤」时什么表都不会变，但这一问确实已经完成。
 *
 * 本列无 DB 级 CHECK（manager 裁决），值集由 lib/agent 保证，写入口只此一处。
 */
export function updateIntakeStage(db: Database, threadId: number, stage: string): void {
  db.prepare('UPDATE threads SET intake_stage = ? WHERE id = ?').run(stage, threadId);
}

/**
 * 读某案问诊线程的落痕进度。取 mode='问诊' 那条线程——
 * 首诊进度是**案件级**的事实，而它只可能在问诊线程上推进；
 * 用户后来在陪跑/文书线程里聊，不该把首诊进度重置回 NULL。
 * 返回 null = 还没落过痕（新案，或问诊线程尚未开）。
 */
export function readIntakeStage(db: Database, caseId: number): string | null {
  const row = db
    .prepare("SELECT intake_stage FROM threads WHERE case_id = ? AND mode = '问诊' ORDER BY id DESC LIMIT 1")
    .get(caseId) as { intake_stage: string | null } | undefined;
  return row?.intake_stage ?? null;
}

export function touchThread(db: Database, threadId: number): void {
  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
}

/** 最近 limit 条消息，按时间正序返回（喂给模型的历史必须是正序） */
export function listRecentMessages(db: Database, threadId: number, limit: number): MessageRow[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit) as MessageRow[];
  return rows.reverse();
}

/** content 传 null = 「生成中」占位（migrate.ts：无 content 即断线重连要续跑的那条） */
export function insertMessage(
  db: Database,
  params: { threadId: number; role: string; content: string | null; model?: string | null },
): number {
  return Number(
    db
      .prepare('INSERT INTO messages (thread_id, role, content, model) VALUES (?, ?, ?, ?)')
      .run(params.threadId, params.role, params.content, params.model ?? null).lastInsertRowid,
  );
}

/**
 * 本线程最后一条 assistant 消息的 id（还没回填正文的空壳不算）。
 *
 * 【它是干什么用的】D14 的拒绝判定要钉在「**我们刚问过**的那一轮」上：
 * 推荐时把 messageId 记进台账 note，用户下一轮说"不需要"时拿它比对。
 * 不这么钉，用户在任何时候说"不需要"（不需要这份证据、不需要开庭…）都会被读成拒绝推荐——
 * 而拒绝是**全局永久**的，误判一次就再也不推了。
 */
export function lastAssistantMessageId(db: Database, threadId: number): number | null {
  const row = db
    .prepare("SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND content IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(threadId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** 流跑完后回填正文与用量。tokensJson 传 null 表示本次没拿到计量（不写 0 冒充） */
export function finalizeMessage(
  db: Database,
  messageId: number,
  params: { content: string; tokensJson: string | null },
): void {
  db.prepare('UPDATE messages SET content = ?, tokens_json = ? WHERE id = ?').run(
    params.content,
    params.tokensJson,
    messageId,
  );
}

// ========== action_items ==========

export function insertActionItem(
  db: Database,
  params: {
    caseId: number;
    title: string;
    detail: string | null;
    /** ISO8601，落库前由 datetime() 归一；null = 无截止 */
    dueAt: string | null;
    priority: number;
    sourceMessageId: number | null;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO action_items (case_id, title, detail, due_at, priority, source_message_id)
         VALUES (?, ?, ?, datetime(?), ?, ?)`,
      )
      .run(
        params.caseId,
        params.title,
        params.detail,
        params.dueAt,
        params.priority,
        params.sourceMessageId,
      ).lastInsertRowid,
  );
}

// ========== deadlines ==========

/**
 * 落一条法定期限。到期日由 lib/deadline 的纯函数算出后传进来，**本层不做任何日期运算**
 * （manager 2026-08-19 范式：期限日期不容模型也不容 SQL 中间层转述）。
 * 同 (case_id, kind, due_at) 已存在则不重复落——同一份裁决书用户可能问两遍。
 */
export function insertDeadline(
  db: Database,
  params: { caseId: number; kind: string; dueDate: string; derivedFrom: string },
): { id: number; created: boolean } {
  const found = db
    .prepare("SELECT id FROM deadlines WHERE case_id = ? AND kind = ? AND date(due_at) = date(?) LIMIT 1")
    .get(params.caseId, params.kind, params.dueDate) as { id: number } | undefined;
  if (found) return { id: found.id, created: false };
  const id = Number(
    db
      .prepare('INSERT INTO deadlines (case_id, kind, due_at, derived_from) VALUES (?, ?, datetime(?), ?)')
      .run(params.caseId, params.kind, params.dueDate, params.derivedFrom).lastInsertRowid,
  );
  return { id, created: true };
}

/**
 * 期限已履行/作废 → 置 resolved_at 停止提醒（migrate.ts：NULL=生效中，非空=已履行/作废）。
 * 只置一次：已 resolved 的再调不刷新时间戳，免得「什么时候办完的」被后来的重复调用改掉。
 * 返回 false 表示这条期限不属于本案或不存在——归属不匹配一律当不存在，不泄漏它在别处存在。
 */
export function resolveDeadline(db: Database, caseId: number, deadlineId: number): boolean {
  const info = db
    .prepare("UPDATE deadlines SET resolved_at = datetime('now') WHERE id = ? AND case_id = ? AND resolved_at IS NULL")
    .run(deadlineId, caseId);
  return info.changes > 0;
}

// ========== claims ==========

/**
 * 按 (case_id, kind) upsert：一个案子里「N」只有一条，改了金额是修正而不是再记一笔。
 * 与 timeline_events 的「只追加」相反——时间线记的是**发生过的事实**（不可改写），
 * claims 记的是**当前主张**（谈判过程中本来就会变），两者纪律不同是有意的。
 * 表上没有 (case_id, kind) 唯一约束（WS1 的建表文件不归本窗口改），故用先查后写。
 */
export function upsertClaim(
  db: Database,
  params: {
    caseId: number;
    kind: string;
    amountFen: number;
    calcJson: string | null;
    basis: string | null;
    status: string;
  },
): { id: number; created: boolean } {
  const found = db
    .prepare('SELECT id FROM claims WHERE case_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(params.caseId, params.kind) as { id: number } | undefined;
  if (found) {
    db.prepare('UPDATE claims SET amount_fen = ?, calc_json = ?, basis = ?, status = ? WHERE id = ?').run(
      params.amountFen,
      params.calcJson,
      params.basis,
      params.status,
      found.id,
    );
    return { id: found.id, created: false };
  }
  const id = Number(
    db
      .prepare('INSERT INTO claims (case_id, kind, amount_fen, calc_json, basis, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(params.caseId, params.kind, params.amountFen, params.calcJson, params.basis, params.status)
      .lastInsertRowid,
  );
  return { id, created: true };
}

export function listClaims(db: Database, caseId: number): ClaimRow[] {
  return db.prepare('SELECT * FROM claims WHERE case_id = ? ORDER BY id').all(caseId) as ClaimRow[];
}

// ========== emotion_log ==========

export function insertEmotionLog(
  db: Database,
  params: { caseId: number; level: string; note: string | null; referredNbdpsy: boolean },
): number {
  return Number(
    db
      .prepare('INSERT INTO emotion_log (case_id, level, note, referred_nbdpsy) VALUES (?, ?, ?, ?)')
      .run(params.caseId, params.level, params.note, params.referredNbdpsy ? 1 : 0).lastInsertRowid,
  );
}

// ========== 危机资源卡的一次性开关 ==========
//
// 【与 referred_nbdpsy 是两个不同的开关，绝不共用】（manager 2026-08-19 加固令）
//   · 本开关 = 免费公益危机热线（charter §5 的救命号码）；
//   · referred_nbdpsy = 商业心理咨询转介（spec §10 的引流红线）。
// 共用一个标记会造成两种都错的后果：给过热线就再也不能转介咨询，
// 或者更糟——转介过咨询就再也不给热线号码。
//
// 落点用 timeline_events 的 `系统动作`（migrate.ts 里这个 kind 本就是为系统落痕设的），
// 而不是往 emotion_log 里塞合成行：emotion_log 是给用户看的情绪走向，掺进系统标记会污染它。

/**
 * 本案上一次把危机资源卡给出去的时刻（canonical 串，ADR-002）；从未给过返回 null。
 * 24 小时窗口的判定输入，窗口比较本身在 lib/agent/crisis 的纯函数里做。
 */
export function lastCrisisCardAt(db: Database, caseId: number, marker: string): string | null {
  const row = db
    .prepare(
      "SELECT happened_at FROM timeline_events WHERE case_id = ? AND kind = '系统动作' AND title = ? ORDER BY happened_at DESC, id DESC LIMIT 1",
    )
    .get(caseId, marker) as { happened_at: string } | undefined;
  return row?.happened_at ?? null;
}

/**
 * 记一笔「危机资源卡已给」。**每次都追加新行**（不再去重）：
 * 时间线本就只追加，而 24 小时窗口要的是「最近一次是什么时候」，
 * 去重只留第一条会让窗口永远从第一次算起，出窗后再给的那次就丢了时间。
 */
export function recordCrisisCardGiven(db: Database, caseId: number, marker: string, detail: string): void {
  db.prepare(
    "INSERT INTO timeline_events (case_id, happened_at, kind, title, detail) VALUES (?, datetime('now'), '系统动作', ?, ?)",
  ).run(caseId, marker, detail);
}

/**
 * 本案「焦虑/严重」情绪记录的条数与**跨越的自然日数**。
 *
 * 【为什么要看自然日跨度】（manager 2026-08-20 定版）
 * 「持续」的语义在**时间跨度**上，不在条数上：同一小时里连记两条只说明那一刻很难受，
 * 不说明这个人处在持续的焦虑抑郁状态。只数条数会把一次急性发作误判成「持续」，
 * 而那正是最不该推销付费咨询的时刻。
 *
 * 自然日按 ADR-002 canonical 串的日期部分比对（created_at 是 'YYYY-MM-DD HH:MM:SS'，
 * 取前 10 字符即当日；canonical 恒为 UTC，跨时区不会因为本地时区飘移而多算一天）。
 */
export function distressEvidence(db: Database, caseId: number): { entries: number; distinctDays: number } {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS entries, COUNT(DISTINCT substr(created_at, 1, 10)) AS days FROM emotion_log WHERE case_id = ? AND level IN ('焦虑','严重')",
    )
    .get(caseId) as { entries: number; days: number };
  return { entries: row.entries, distinctDays: row.days };
}

/** 本案是否已经转介过 NBDpsy。spec §10：一案最多提示一次，这是那条红线的判据。 */
export function hasReferredNbdpsy(db: Database, caseId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM emotion_log WHERE case_id = ? AND referred_nbdpsy = 1 LIMIT 1')
    .get(caseId) as { hit: number } | undefined;
  return !!row;
}

// ========== company_profiles ==========

/** 按 (case_id, name) upsert：同一家公司反复补充信息是常态（先只知道名字，后来查到统一社会信用代码）。 */
export function upsertCompanyProfile(
  db: Database,
  params: {
    caseId: number;
    name: string;
    uscc: string | null;
    role: string;
    legalRep: string | null;
    riskNotes: string | null;
    sourcesJson: string | null;
  },
): { id: number; created: boolean } {
  const found = db
    .prepare('SELECT id FROM company_profiles WHERE case_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
    .get(params.caseId, params.name) as { id: number } | undefined;
  if (found) {
    db.prepare(
      `UPDATE company_profiles SET uscc = COALESCE(?, uscc), role = ?, legal_rep = COALESCE(?, legal_rep),
       risk_notes = COALESCE(?, risk_notes), sources_json = COALESCE(?, sources_json),
       investigated_at = datetime('now') WHERE id = ?`,
    ).run(params.uscc, params.role, params.legalRep, params.riskNotes, params.sourcesJson, found.id);
    return { id: found.id, created: false };
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO company_profiles (case_id, name, uscc, role, legal_rep, risk_notes, sources_json, investigated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        params.caseId,
        params.name,
        params.uscc,
        params.role,
        params.legalRep,
        params.riskNotes,
        params.sourcesJson,
      ).lastInsertRowid,
  );
  return { id, created: true };
}

export function listCompanyProfiles(db: Database, caseId: number): CompanyProfileRow[] {
  return db
    .prepare('SELECT * FROM company_profiles WHERE case_id = ? ORDER BY id')
    .all(caseId) as CompanyProfileRow[];
}

// ========== drafts ==========

/** 同 kind 每写一次就是新一版（version = 现有最大值 + 1），旧版留着让用户回看上一稿措辞。 */
export function insertDraft(
  db: Database,
  params: { caseId: number; kind: string; title: string; content: string; status: string },
): DraftRow {
  const max = db
    .prepare('SELECT MAX(version) AS v FROM drafts WHERE case_id = ? AND kind = ?')
    .get(params.caseId, params.kind) as { v: number | null };
  const version = (max.v ?? 0) + 1;
  const id = Number(
    db
      .prepare('INSERT INTO drafts (case_id, kind, title, content, version, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(params.caseId, params.kind, params.title, params.content, version, params.status).lastInsertRowid,
  );
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow;
}
