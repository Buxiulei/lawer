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
import { submitIntakeInto, type IntakeInput, type IntakeResult } from './intake';
import { CASE_STAGES } from './stages';
// drafts 的 SQL 早已在 lib/db/agent.ts 的 drafts 段（与 insertDraft 同处）。读侧不另起
// 一份表访问：同一张表两处 SELECT，将来加一列就会漏一处。归属校验仍在本文件把关。
import { listDrafts as listDraftRows, listCaseMessages, type DraftRow } from '@/lib/db/agent';
import { nowSql } from '@/lib/db/time';
// 历史消息要标「这一轮实际是谁答的」，判「实际 ≠ 请求」的口径只有记账那一处
// （billing/served-model）。在这儿另写一个 `a !== b` 就是同一个问题两个答案：
// 前缀（relay/）与变体后缀（:think）都会让逐字比较判错，而它俩恰恰不是换型号。
import { reconcileServedModel } from '@/lib/billing/served-model';

// 阶段词表单独成文件（lib/cases/stages.ts），因为首诊页也要按阶段取那三件事，
// 而页面引 lib/cases 会把整个 lib/db 拖进浏览器包。此处原样再导出，引用方不必改。
export { CASE_STAGES, type CaseStage } from './stages';
export type { IntakeInput, IntakeResult } from './intake';

/** 与 migrate.ts timeline_events.kind 注释逐字对齐 */
export const TIMELINE_KINDS = ['公司动作', '我方动作', '系统动作', '期限'] as const;

/**
 * 案件里程碑（批 6 驾驶舱，契约 docs/contracts/case-milestone.md §三）。
 *
 * 【为什么不是 CASE_STAGES 的子集】里程碑是**只追加的既成事实**，stage 是**可变可回退的
 * 当前态**，是两种东西（契约 §二）。早先按子集写过一稿，撞上死结：第一格「协商」在
 * CASE_STAGES 里没有对应值（那段被拆成 风声/约谈中/已收通知/已解除 四个更细的值），
 * 只能拿 `约谈中` 当键——于是「公司不谈直接解除」的案子库里会留下一条从没发生过的约谈。
 * 而且 `Extract<CaseStage, …>` **fails open**：把 CASE_STAGES 里某个值改名，
 * 里程碑联合会**静默少一员，tsc 退出码 0 一句话不报**（2026-08-28 本仓实测）——
 * 一个防词表漂移的机制，自己的失效方式就是静默漂移。改成独立联合 + 下面那张全量表，
 * 漏键报 TS2741、错值报 TS2322，**两个方向都红**。
 */
export const CASE_MILESTONES = [
  '协商',
  '仲裁申请',
  '立案',
  '开庭',
  '裁决',
  '一审',
  '二审',
  '执行',
] as const;

export type CaseMilestone = (typeof CASE_MILESTONES)[number];

/**
 * stage → 它属于哪个里程碑。**全量**：键覆盖 CASE_STAGES 每一个值。
 * 新增或改名任一 stage，此处不补即编译失败——这正是 Extract 给不了的那一格。
 */
export const MILESTONE_OF_STAGE: Record<(typeof CASE_STAGES)[number], CaseMilestone | null> = {
  风声: null, // 还没进入任何里程碑
  约谈中: '协商',
  已收通知: '协商',
  已解除: '协商',
  仲裁准备: '仲裁申请',
  已立案: '立案',
  开庭: '开庭',
  裁决: '裁决',
  一审: '一审',
  二审: '二审',
  执行: '执行',
  结案: null, // 轨道末格已达成，不再是「当前里程碑」
};

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

/**
 * 校验 API 传进来的 ISO8601 时间串（ADR-002：边界转换在这一层做）。
 * 这里只负责"是不是个合法时间"，落库格式的归一交给 SQL 的 datetime()，
 * 免得应用层再自己拼一套格式跟 canonical 打架。
 */
function normalizeIsoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ========== 建档 ==========

/** 注册后自动建的那个案件；用户想改名走 cases 的更新面，这里只管第一次 */
const DEFAULT_CASE_TITLE = '我的案件';

/**
 * 确保用户名下有案件，没有就建一个并写一条欢迎事件（注册完成时由 lib/auth 调用）。
 *
 * 幂等判据是"名下有没有**任何**案件"，而不是"有没有叫我的案件的那个"：
 * 用户第二次验邮箱、或已经自己建过案，都不该再冒出一个空档案。
 * 建案与欢迎事件同一事务：只有案件没有欢迎事件的半截档案不该存在。
 */
export function ensureDefaultCase(
  db: Database,
  userId: number,
): { caseId: number; isNew: boolean } {
  const existing = store.listCasesByUser(db, userId);
  if (existing.length > 0) return { caseId: existing[0].id, isNew: false };

  const create = db.transaction(() => {
    const caseId = store.insertCase(db, { userId, title: DEFAULT_CASE_TITLE });
    store.insertTimelineEvent(db, {
      caseId,
      happenedAt: nowSql(),
      kind: '系统动作',
      title: '档案已建立',
      detail:
        '从现在起，公司说了什么、发了什么文件、你回了什么，都记到这条时间线上。' +
        '拿不准下一步做什么，直接问我。',
    });
    return caseId;
  });
  return { caseId: create(), isNew: true };
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

/**
 * 案件名下的文书。文书目前只由对话里的 draft_write 产出，本函数是它唯一的读出口——
 * 在此之前文书页对任何案件都渲染演示数据，真实用户在自己案子里读到的是别家公司的文书。
 */
export function listDrafts(
  db: Database,
  input: { caseId: number; userId: number },
): Result<{ drafts: DraftRow[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;
  return { ok: true, drafts: listDraftRows(db, input.caseId) };
}

/** 回显给页面的一条历史消息。字段名照库里的行（snake_case），与 drafts 端点同口径。 */
export interface CaseMessageView {
  id: number;
  role: string;
  content: string;
  created_at: string;
  /** 我们请求的型号（messages.model，API 别名）。历史行可能没有 */
  model: string | null;
  /** 厂商回显的**实际**服务型号；null = 这一轮没回显过 */
  served_model: string | null;
  /** 实际服务的型号与请求的不是同一个（含未登记的新快照串） */
  served_mismatch: boolean;
}

/** 一次最多回多少条。够长到覆盖一个案子的全部对话，又不至于让首屏拖着几 MB 正文 */
export const MESSAGE_PAGE_SIZE = 200;

/**
 * tokens_json（orchestrator 写的 {model, usage, servedModel}）→ 展示要的两项。
 * 解析不出来一律当"不知道"：坏的 JSON 不该让整条消息读不出来。
 */
function servedOf(tokensJson: string | null): { served: string | null; mismatch: boolean } {
  if (!tokensJson) return { served: null, mismatch: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokensJson);
  } catch {
    return { served: null, mismatch: false };
  }
  if (typeof parsed !== 'object' || parsed === null) return { served: null, mismatch: false };
  const rec = parsed as { model?: unknown; servedModel?: unknown };
  const served =
    typeof rec.servedModel === 'string' && rec.servedModel.trim() ? rec.servedModel : null;
  if (served === null || typeof rec.model !== 'string') return { served, mismatch: false };
  // rateOf 不传：这里只要「是不是换了型号」这个身份结论，不做计价方向裁决（钱在记账那侧已经算过）
  return { served, mismatch: reconcileServedModel(rec.model, served).trace !== null };
}

/**
 * 案件的历史对话。**在此之前这条读出口根本不存在**——库里一直有（messages 表），
 * 但只喂给服务端拼上下文（listRecentMessages），网页从来没取过。
 * 于是用户关掉页面再打开，聊过的一切在屏幕上消失得干干净净，
 * 而它们其实一条不少地躺在库里。
 */
export function listMessages(
  db: Database,
  input: { caseId: number; userId: number },
): Result<{ messages: CaseMessageView[] }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const messages = listCaseMessages(db, input.caseId, MESSAGE_PAGE_SIZE).map((row) => {
    const { served, mismatch } = servedOf(row.tokens_json);
    return {
      id: row.id,
      role: row.role,
      // SQL 已经把 content IS NULL 的占位行滤掉了，这里的非空是那一条的结论
      content: row.content!,
      created_at: row.created_at,
      model: row.model,
      served_model: served,
      served_mismatch: mismatch,
    };
  });
  return { ok: true, messages };
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

/**
 * 首诊提交：六步内容一次性写进**这个人自己的案件**。
 * 归属校验在这里做完（不是自己的案件与不存在的一样回 404），落库细节在 ./intake。
 */
export function submitIntake(
  db: Database,
  input: IntakeInput,
): Result<{ result: IntakeResult }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  const done = submitIntakeInto(db, input.caseId, input);
  if (!done.ok) return done;
  return { ok: true, result: done.result };
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
  });
  const event = store.listTimelineEvents(db, input.caseId, TIMELINE_MAX_LIMIT).find((e) => e.id === id)!;
  return { ok: true, event };
}

/**
 * 给一条已存在的时间线事件盖上里程碑。**这是全仓唯一能写 milestone 的入口。**
 *
 * 【为什么要 userConfirmed 这个参数】契约 §四 定的是「零自动写入」——八格全部
 * 「agent 提议 + 用户一键确认」，没有任何一格由规则自动写。产品理由是
 * **milestone 是只追加、不可撤销的事实断言，不可撤销的写入不许由启发式产生**：
 * 抽错一次就永久多一格，而按定义没有撤销语义（有撤销就回到"能被抹掉"，
 * 整套「回退不算倒退、时间轴如实记」的设计白做）。
 *
 * 这个参数是那条规矩的**签名级落法**：调用方不显式声明"用户确认过"就调不动它。
 * 它挡不住存心造假的调用方（那不是它的目标），挡的是**顺手**——agent 侧想自动盖章，
 * 必须先写下一句显然是假的 `userConfirmed: true`，而不是漏个参数就悄悄写成了。
 */
export function confirmMilestone(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    eventId: number;
    milestone?: unknown;
    /** 用户确认凭据，必须显式为 true */
    userConfirmed?: unknown;
  },
): Result<{ event: store.TimelineEventRow }> {
  const found = assertOwned(db, input.caseId, input.userId);
  if (isFailure(found)) return found;

  if (input.userConfirmed !== true) {
    return fail(
      400,
      'MILESTONE_NOT_CONFIRMED',
      '里程碑必须由用户确认后才能写入：agent 只递笔，案件史归用户执笔',
    );
  }
  if (
    typeof input.milestone !== 'string' ||
    !(CASE_MILESTONES as readonly string[]).includes(input.milestone)
  ) {
    return fail(400, 'INVALID_MILESTONE', `milestone 只能是 ${CASE_MILESTONES.join(' / ')}`);
  }

  const updated = store.setEventMilestone(db, {
    caseId: input.caseId,
    eventId: input.eventId,
    milestone: input.milestone,
  });
  if (!updated) return fail(404, 'EVENT_NOT_FOUND', '时间线事件不存在');

  const event = store
    .listTimelineEvents(db, input.caseId, TIMELINE_MAX_LIMIT)
    .find((e) => e.id === input.eventId)!;
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
