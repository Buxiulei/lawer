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
  /** 案件领域（MCP 设计稿 §13）。取值即 lib/domains 的领域包 key；存量行由迁移默认值补齐 */
  domain: string;
  /**
   * 当前所在的**并行轨**（设计稿 §16），取值来自领域包的 tracks。
   * NULL = 只在主线上——这是正确语义，不是"还没填"；没有并行轨的领域这一列恒为 NULL。
   */
  track: string | null;
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
  /**
   * 用户按下删除的时刻（软删标记）；NULL = 没删过。
   * 非空的行**在本文件的两个读入口里根本取不出来**（findCaseById / listCasesByUser），
   * 所以业务侧读到的 CaseRow 这一列恒为 NULL；要读被删的行走 findCaseByIdIncludingDeleted。
   *
   * 【为什么可选】库里这一列一定在（迁移建的），但仓里有若干处手搓 CaseRow 字面量的
   * 纯函数判据——它们喂给的是「业务层看到的案件」，而业务层看到的案件从定义上就没被删过。
   * 写成必填只会逼那些判据补一个恒为 null 的字段，读起来像是它有什么意义。
   */
  deleted_at?: string | null;
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
  /** 来源四档（lib/cases/source-tier.ts）。存量行由迁移回填「自述」 */
  source_tier: string;
  /** 谁写进来的（user / agent_inferred / doc_extract / system）。存量行回填 user */
  asserted_by: string;
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
  /** none / queued / running / done / failed（见 lib/jobs/extraction-worker） */
  extraction_status: string;
  extracted_at: string | null;
  /** 简报原文（JSON 串）。读侧一律经 lib/evidence/brief.parseBrief 解，别自己 JSON.parse */
  brief_json: string | null;
  brief_version: number;
  /** 最近一次自动生成简报失败的原因；null = 没失败过 */
  brief_error: string | null;
  /** 作废理由；null = 没作废 */
  void_reason: string | null;
  /** 作废时刻（canonical 串）；null = 没作废 */
  voided_at: string | null;
  /**
   * **简报结论**的来源四档与断言人（不是这份材料本身的档位）。
   * 由内容提取写出来的简报是「书证 / doc_extract」；人手改写过的是「自述 / user」。
   * 存量行由迁移回填「自述 / user」——旧简报里有一部分是按元数据写成的推测，
   * 一律按最弱档处理才不会把推测当成读过原文的结论。
   */
  brief_source_tier: string;
  brief_asserted_by: string;
}

// ========== cases ==========

/**
 * 建一个新案件。stage 与 district 取 DDL 默认值，不在这里再写一份——
 * 默认值只该有一个出处，两处各写一遍迟早会不一致。
 *
 * `domain` 同理：不给就走 DDL 默认值（缺省领域）。**本层不认识任何领域**，
 * 该建哪个领域由 lib/cases 那层判（它要过灰度开关那道闸）。
 */
export function insertCase(
  db: Database,
  params: { userId: number; title: string; domain?: string },
): number {
  const info =
    params.domain === undefined
      ? db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(params.userId, params.title)
      : db
          .prepare('INSERT INTO cases (user_id, title, domain) VALUES (?, ?, ?)')
          .run(params.userId, params.title, params.domain);
  return Number(info.lastInsertRowid);
}

/**
 * 按 id 取一个案件。**已软删的行在这里取不出来**（回 undefined）。
 *
 * 【为什么过滤写在这一处，而不是让每个调用方各加一句 `AND deleted_at IS NULL`】
 * 本函数是 lib/cases.assertOwned 的唯一取数口，而 assertOwned 是全部按 case_id 的读写
 * 必经的那道门。过滤放在这里，一条也漏不掉；让四十几个调用方各自记得加一句的形态是：
 * 忘掉的那一处照常返回 200，用户已经删掉的案子从那个入口仍然读得出来、写得进去，
 * 而没有任何一处会报错。
 */
export function findCaseById(db: Database, caseId: number): CaseRow | undefined {
  return db.prepare('SELECT * FROM cases WHERE id = ? AND deleted_at IS NULL').get(caseId) as
    | CaseRow
    | undefined;
}

/**
 * 「这个 case_id 是不是这个人的、且还在」——**按 case_id 取数的归属判据只有这一份**。
 * 取不到（不存在 / 不是本人的 / 已被删）一律 undefined，调用方回同一个 404，三者不区分。
 *
 * 【为什么要有它，findCaseById 还不够】lib/cases.assertOwned 走的是 findCaseById，
 * 那条路上的四十几个入口都对。问题出在**不经 lib/cases 的那几处**（按量报价、文书审查、
 * crisis_check 带案调用、来文解读）：它们各自手写了一句
 * `SELECT id FROM cases WHERE id=? AND user_id=?`——归属对，但少了软删那半句，
 * 于是用户删掉的案子在这些接口上照样读得出、照样能发起付费动作，而删除回包答应过
 * 「在所有页面与接口上都不再出现」。独立写 N 次就会忘 N 次，所以收成这一个函数，
 * 并由 __tests__/soft-delete-scope.test.ts 扫源码机检：还有谁在裸查 cases 就点谁的名。
 */
export function findOwnedCase(db: Database, caseId: number, userId: number): CaseRow | undefined {
  return db
    .prepare('SELECT * FROM cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(caseId, userId) as CaseRow | undefined;
}

/**
 * 连已软删的行一起取。**只有生命周期那条路该用它**（删除本身要幂等、清理任务要按
 * deleted_at 找到期的行）。业务读一律用 findCaseById——两个函数同名不同义会让人随手拿错，
 * 所以这个名字写得又长又刺眼。
 */
export function findCaseByIdIncludingDeleted(db: Database, caseId: number): CaseRow | undefined {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as CaseRow | undefined;
}

export function listCasesByUser(db: Database, userId: number): CaseRow[] {
  return db
    .prepare('SELECT * FROM cases WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC')
    .all(userId) as CaseRow[];
}

/** 某人名下**全部**案件，含已软删的（注销时要把它们一并标删）。 */
export function listCasesByUserIncludingDeleted(db: Database, userId: number): CaseRow[] {
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
    /** 并行轨；显式传 null = 出轨回主线（与"这次没传"是两件事，见下面的 !== undefined） */
    track?: string | null;
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
    'track',
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
 * 时间线读侧的列清单。**五处 SELECT 共用这一份**（按 client_ref 找、同日同类、
 * 窗口取、分页取、取最早一条）。
 *
 * 【为什么提成常量】这张表加一列时要同时改五处 SELECT，而漏掉其中一处的形态是：
 * 那一条读路径回来的行**少一个字段**，TypeScript 照样过（它信 `as TimelineEventRow`），
 * 读侧拿到 `undefined` 当作"这条没有档位"——于是一条有书证的事件在某一个入口里
 * 被渲染成〔未记录〕，而没有任何一处会报错。S4 加 source_tier / asserted_by 时
 * 正是踩在这个形状上，所以先把入口收成一个。
 */
const TIMELINE_COLUMNS =
  'id, case_id, happened_at, kind, title, detail, milestone, source_tier, asserted_by, created_at';

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
    /**
     * 来源四档与断言人，**成对给或成对不给**（省略 ⇒ 走 DDL 默认值：自述 / user）。
     *
     * 【为什么是一个 pair 而不是两个独立可选参数】两个独立参数允许"只给档位不给断言人"，
     * 而那种行只写了一半：一条标着「书证」却记着 user 的事件，读起来像用户自己上传了原件，
     * 实际是提取器写的。成对入参在**类型上**堵掉这种半行。
     * 值域校验在 lib/cases（本层不认识业务枚举，同 kind / status 的既定分工）；
     * 默认字面量的唯一正本在 DDL，本层不再抄一份。
     */
    origin?: { tier: string; assertedBy: string };
  },
): number {
  const { origin } = params;
  const info = origin
    ? db
        .prepare(
          'INSERT INTO timeline_events (case_id, happened_at, kind, title, detail, client_ref, source_tier, asserted_by)' +
            ' VALUES (?, datetime(?), ?, ?, ?, ?, ?, ?)',
        )
        .run(
          params.caseId,
          params.happenedAt,
          params.kind,
          params.title,
          params.detail,
          params.clientRef ?? null,
          origin.tier,
          origin.assertedBy,
        )
    : db
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
      `SELECT ${TIMELINE_COLUMNS} FROM timeline_events WHERE case_id = ? AND client_ref = ? LIMIT 1`,
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
      `SELECT ${TIMELINE_COLUMNS}
         FROM timeline_events
        WHERE case_id = ? AND kind = ? AND date(happened_at) = date(?)`,
    )
    .all(caseId, kind, happenedAt) as TimelineEventRow[];
}

export function listTimelineEvents(db: Database, caseId: number, limit: number): TimelineEventRow[] {
  return db
    .prepare(
      `SELECT ${TIMELINE_COLUMNS} FROM timeline_events WHERE case_id = ? ORDER BY happened_at DESC, id DESC LIMIT ?`,
    )
    .all(caseId, limit) as TimelineEventRow[];
}

/**
 * 分页取时间线：可按发生时间下界（since）与类别（kind）过滤，按 happened_at 降序、
 * 同刻按 id 降序（与 listTimelineEvents 同一口径，否则两个接口对同一批数据给出两种顺序）。
 *
 * 【为什么连 total 一起回】只回一页的话，调用方无从知道"后面还有没有"，
 * 于是要么每次都翻到空页才收手，要么把一页当成全部——后者会让 agent 断言
 * 「你的案子一共就这 N 件事」，而那句话正是用户最没法自己核对的。
 * total 是**过滤后**的总数，与本页用同一套 WHERE。
 */
export function listTimelinePage(
  db: Database,
  params: { caseId: number; since?: string | null; kind?: string | null; limit: number; offset: number },
): { events: TimelineEventRow[]; total: number } {
  const where = ['case_id = ?'];
  const args: unknown[] = [params.caseId];
  if (params.since) {
    // 【必须过 datetime()】happened_at 落库时就是 datetime(?) 归一后的
    // 'YYYY-MM-DD HH:MM:SS'（见 insertTimelineEvent），而入参是 ISO 串带 'T' 和毫秒。
    // 直接拿 ISO 串比大小是字符串比较：'T' > ' '，于是**恰好等于下界那一刻的事件会被漏掉**，
    // 而结果看起来完全正常——少的那条正是"从这天起"最该看到的第一条。
    where.push('happened_at >= datetime(?)');
    args.push(params.since);
  }
  if (params.kind) {
    where.push('kind = ?');
    args.push(params.kind);
  }
  const clause = where.join(' AND ');
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM timeline_events WHERE ${clause}`).get(...args) as { n: number }).n,
  );
  const events = db
    .prepare(
      `SELECT ${TIMELINE_COLUMNS}
         FROM timeline_events WHERE ${clause}
        ORDER BY happened_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, params.limit, params.offset) as TimelineEventRow[];
  return { events, total };
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
        `SELECT ${TIMELINE_COLUMNS} FROM timeline_events WHERE case_id = ? ORDER BY happened_at ASC, id ASC LIMIT 1`,
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

/**
 * 案件名下的证据。**默认不含已作废的条目**（includeVoided 才回）。
 *
 * 【为什么过滤写在这一层】事实卡、MCP 的 evidence_list、网页证据库读的都是这一个函数。
 * 让三个读点各自 `filter(r => r.status !== 已作废)` 的形态是：漏掉一处，那一处就会把
 * 用户已经声明「这份不作数」的材料继续当成证据用——而它看起来完全正常。
 */
export function listEvidence(
  db: Database,
  caseId: number,
  includeVoided = false,
): EvidenceRow[] {
  const columns = `id, case_id, name, category, prove_purpose, status, created_at,
              extraction_status, extracted_at, brief_json, brief_version, brief_error,
              void_reason, voided_at, brief_source_tier, brief_asserted_by`;
  return db
    .prepare(
      `SELECT ${columns}
         FROM evidence WHERE case_id = ?${includeVoided ? '' : ' AND voided_at IS NULL'}
        ORDER BY id DESC`,
    )
    .all(caseId) as EvidenceRow[];
}
