'use client';

/**
 * 驾驶舱数据层：真接口调用 + demo（演示案件）的 mock 适配。
 * 页面组件只认这里的视图类型，不认后端字段名，也不认数据是真是假。
 *
 * 【立这一层的由头（P0 第三层）】Dashboard 原本只有一句
 *   `const seeded = caseId === demoCase.id`，认的是字面量 demo，
 * 真实案件一律 `return <FirstCase/>`——名下躺着整套时间线、行动卡、期限、证据的人
 * 打开驾驶舱，看到的是「还没有你的案件」。数据一直在库里，**这一页从没去取过**。
 * 症状与「路由把人送进演示案件」在用户嘴里是同一句：我看不到我的记录。
 *
 * 接口形状取自同仓路由实现：
 *   GET   /api/v1/cases/{id}?timeline_limit=200  档案 + 时间线（里程碑在 timeline[].milestone）
 *   GET   /api/v1/cases/{id}/actions             行动卡
 *   GET   /api/v1/cases/{id}/deadlines           期限（默认只回未了结的）
 *   GET   /api/v1/cases/{id}/evidence            证据（只有元数据）
 *   PATCH /api/v1/cases/{id}/actions/{actionId}  勾完成 / 取消
 * 一个新端点都没加：数据本来就都在。
 */

import {
  demoActions,
  demoCompanyDocs,
  demoDeadlines,
  demoEvidence,
  demoTimeline,
} from '@/app/_mock/demo';
import type {
  ActionItem,
  ActionStatus,
  Deadline,
  DeadlineKind,
} from '@/app/_mock/types';
import { apiFetch, ApiError, humanError } from '@/app/_ui/api';
import type { BadgeTone } from '@/components/shadcn/badge';
import { demoAttainments, type Attainment, type Milestone } from './milestones';

/** 「最近的材料」里的一行。证据与公司文件在这里已经拉平成同一种东西。 */
export interface RecordRow {
  key: string;
  name: string;
  tag: string;
  tone: BadgeTone;
  href: string;
  at: string;
}

export interface DashboardData {
  actions: ActionItem[];
  deadlines: Deadline[];
  attainments: Attainment[];
  records: RecordRow[];
  /**
   * 这个案件有多少条时间线事件。**不是 attainments 的替身**：
   * attainments 只数带 milestone 的那几条，而首诊记下的「HR 找我谈」之类一条 milestone 都没有。
   * 只看行动卡/期限/里程碑/材料判空，会让一个刚讲完全部经过的人看到「这个案件还是空的」。
   */
  timelineCount: number;
}

/** 四块全空且时间线也空＝这个案件确实还什么都没有（刚注册建的档），这时才该出建档引导 */
export function isBlank(data: DashboardData): boolean {
  return (
    data.actions.length === 0 &&
    data.deadlines.length === 0 &&
    data.attainments.length === 0 &&
    data.records.length === 0 &&
    data.timelineCount === 0
  );
}

/**
 * 取数没成的两种：**能重试的**（网络、5xx）与**终局的**（这个案件不存在或不属于你）。
 * 两者的界线是「材料还在不在」——对终局的那种说「你的案件和材料都还在」是在骗人，
 * 而给它一个重试按钮，用户会一直点下去。
 */
export interface LoadFailure {
  message: string;
  kind: 'transient' | 'missing';
}

export type ViewState = 'failed' | 'missing' | 'loading' | 'blank' | 'ready';

/**
 * 异常 → 哪一种失败。CASE_NOT_FOUND 是**终局**：后端对「不存在」和「不是你的」回同一个码
 * （lib/cases 的红线：403 等于承认这个案件号有效，攻击者能靠遍历 id 数出平台有多少案件）。
 * 两者都不该给重试按钮，更不该顺口保证「你的案件和材料都还在」——那份材料可能不是他的。
 */
export function failureOf(err: unknown): LoadFailure {
  const missing = err instanceof ApiError && err.errorCode === 'CASE_NOT_FOUND';
  return { message: humanError(err), kind: missing ? 'missing' : 'transient' };
}

/**
 * 这一屏该画哪一种。抽成纯函数是为了让「没取到」与「确实没有」这条界线验得出来：
 * 两者在屏幕上都是"一片什么都没有"，但一个该说"再试一次"、另一个该说"去建档"，
 * 而把前者画成后者，等于告诉一个名下有整套记录的人——你没有案件。
 *
 * 出错优先于一切：手里那份 data 可能是上一次的残留，不能拿它盖住错误。
 */
export function viewState(input: {
  error: LoadFailure | null;
  data: DashboardData | null;
}): ViewState {
  if (input.error !== null) return input.error.kind === 'missing' ? 'missing' : 'failed';
  if (input.data === null) return 'loading';
  return isBlank(input.data) ? 'blank' : 'ready';
}

/* ── 枚举收口：后端多出一个值时按最保守的那档渲染，但要出声 ───────── */

const ACTION_STATUSES: readonly ActionStatus[] = ['待办', '完成', '放弃'];

const DEADLINE_KINDS: readonly DeadlineKind[] = [
  '仲裁时效',
  '起诉15日',
  '上诉15日',
  '举证期限',
  '开庭',
  '申请执行2年',
  '自定义',
];

/**
 * 轨道上的八段。**漏一个就编译不过**：下面那张全量表少一个键报 TS2741，
 * 多一个报 TS2353——`Milestone` 将来加一段时，这里不补就红，不会静默少一格。
 */
const MILESTONE_SET: Record<Milestone, true> = {
  协商: true,
  仲裁申请: true,
  立案: true,
  开庭: true,
  裁决: true,
  一审: true,
  二审: true,
  执行: true,
};

const EVIDENCE_TONE: Record<string, BadgeTone> = {
  已上传: 'neutral',
  已固化: 'success',
  已出证: 'primary',
};

function toActionStatus(raw: string): ActionStatus {
  if (ACTION_STATUSES.includes(raw as ActionStatus)) return raw as ActionStatus;
  console.warn('[dashboard] 未知的行动卡状态，按「待办」渲染：', raw);
  return '待办';
}

function toDeadlineKind(raw: string): DeadlineKind {
  if (DEADLINE_KINDS.includes(raw as DeadlineKind)) return raw as DeadlineKind;
  console.warn('[dashboard] 未知的期限类型，按「自定义」渲染：', raw);
  return '自定义';
}

/** 1/2/3 之外的优先级按最低档渲染——排序会因此下沉，但不会把一张卡弄丢 */
function toPriority(raw: number): 1 | 2 | 3 {
  return raw === 1 || raw === 2 || raw === 3 ? raw : 3;
}

/* ── 后端行的形状（照 lib/db/cases 的 *Row）─────────────────────── */

interface ApiCaseRow {
  id: number;
  title: string;
  stage: string;
}

interface ApiTimelineRow {
  id: number;
  happened_at: string;
  kind: string;
  title: string;
  detail: string | null;
  milestone: string | null;
}

interface ApiActionRow {
  id: number;
  case_id: number;
  title: string;
  detail: string | null;
  due_at: string | null;
  priority: number;
  status: string;
  created_at: string;
}

interface ApiDeadlineRow {
  id: number;
  case_id: number;
  kind: string;
  due_at: string;
  derived_from: string | null;
}

interface ApiEvidenceRow {
  id: number;
  name: string;
  status: string;
  created_at: string;
}

/* ── 行 → 视图 ──────────────────────────────────────────────── */

function toAction(row: ApiActionRow): ActionItem {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    title: row.title,
    detail: row.detail ?? '',
    dueAt: row.due_at,
    priority: toPriority(row.priority),
    status: toActionStatus(row.status),
    // 后端行动卡不记「是哪条回复生成的」，给 null 而不是编一个 id
    sourceMessageId: null,
    createdAt: row.created_at,
  };
}

/**
 * 期限卡面上那行字取 `kind`。
 * 库里没有 title 这一列（见 lib/db/cases.DeadlineRow），**不拿 derived_from 顶**——
 * 那是一整句推算依据（「自 X 月 X 日收到解除通知起算一年」），塞进两行高的小卡里会截断，
 * 而截断后的半句话比只写「仲裁时效」更难懂。完整依据留在期限页展开看。
 */
function toDeadline(row: ApiDeadlineRow): Deadline {
  const kind = toDeadlineKind(row.kind);
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    kind,
    title: kind,
    dueAt: row.due_at,
    derivedFrom: row.derived_from ?? '',
  };
}

/**
 * 时间线里带里程碑的事件＝轨道上的达成点。
 * 认不出的里程碑值丢掉但要出声：静默丢弃的后果是「轨道少一格」，
 * 而少一格在页面上跟「还没走到那一步」长得一模一样，没有任何异常信号。
 */
function toAttainments(timeline: ApiTimelineRow[]): Attainment[] {
  const out: Attainment[] = [];
  for (const row of timeline) {
    if (row.milestone === null) continue;
    if (!(row.milestone in MILESTONE_SET)) {
      console.warn('[dashboard] 时间线上有认不出的里程碑，已忽略：', row.milestone);
      continue;
    }
    out.push({ milestone: row.milestone as Milestone, happenedAt: row.happened_at });
  }
  return out;
}

function toRecord(row: ApiEvidenceRow, caseId: string): RecordRow {
  return {
    key: `ev-${row.id}`,
    name: row.name,
    tag: row.status,
    tone: EVIDENCE_TONE[row.status] ?? 'neutral',
    href: `/case/${caseId}/evidence`,
    at: row.created_at,
  };
}

/** 最近三条，新的在前。demo 与真实走同一个裁剪口径 */
function latestThree(rows: RecordRow[]): RecordRow[] {
  return [...rows].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
}

/* ── 取数 ───────────────────────────────────────────────────── */

/**
 * 驾驶舱一屏所需的全部数据。四条接口并发，任何一条失败就整体抛——
 * **不做「这块取到了就先画这块」的半屏渲染**：用户没法分辨"这一格是空的"
 * 和"这一格没取到"，而这两件事在本页的分量完全不同。
 *
 * 时间线要满 200（后端上限）而不是默认的 50：里程碑事件可能压在很早的位置，
 * 取少了轨道会少一格，且没有任何异常信号。
 */
export async function fetchDashboard(caseId: string): Promise<DashboardData> {
  const [detail, actions, deadlines, evidence] = await Promise.all([
    apiFetch<{ case: ApiCaseRow; timeline: ApiTimelineRow[] }>(
      `/cases/${caseId}?timeline_limit=200`,
    ),
    apiFetch<{ actions: ApiActionRow[] }>(`/cases/${caseId}/actions`),
    apiFetch<{ deadlines: ApiDeadlineRow[] }>(`/cases/${caseId}/deadlines`),
    apiFetch<{ evidence: ApiEvidenceRow[] }>(`/cases/${caseId}/evidence`),
  ]);

  return {
    actions: actions.actions.map(toAction),
    deadlines: deadlines.deadlines.map(toDeadline),
    attainments: toAttainments(detail.timeline),
    timelineCount: detail.timeline.length,
    // 公司文件（「解读结论：不签」那一类）后端还没有列表接口，真实案件这一半先只有证据。
    // 不拿 demoCompanyDocs 填——那会把编的公司名混进用户自己的材料列表里。
    records: latestThree(evidence.evidence.map((row) => toRecord(row, caseId))),
  };
}

/** 演示案件走这条，一次网络请求都不发 */
export function demoDashboard(caseId: string): DashboardData {
  return {
    actions: demoActions,
    deadlines: demoDeadlines,
    attainments: demoAttainments(),
    records: demoRecords(caseId),
    timelineCount: demoTimeline.length,
  };
}

/** 勾完成 / 取消勾选。后端只有「完成 / 放弃 / 待办」三态，取消勾即回「待办」 */
export async function saveActionStatus(
  caseId: string,
  actionId: string,
  done: boolean,
): Promise<void> {
  await apiFetch(`/cases/${caseId}/actions/${actionId}`, {
    method: 'PATCH',
    body: { status: done ? '完成' : '待办' },
  });
}

/* ── demo 适配 ─────────────────────────────────────────────── */

export function demoRecords(caseId: string): RecordRow[] {
  return latestThree([
    ...demoEvidence.map((e) => ({
      key: `ev-${e.id}`,
      name: e.name,
      tag: e.status,
      tone: EVIDENCE_TONE[e.status] ?? ('neutral' as BadgeTone),
      href: `/case/${caseId}/evidence`,
      at: e.createdAt,
    })),
    ...demoCompanyDocs.map((d) => ({
      key: `doc-${d.id}`,
      name: d.title,
      // 「签不签」是这类文件上最重的一个字，列表里也不降级成「已解读」
      tag: `结论：${d.advice}`,
      tone: (d.advice === '不签' ? 'danger' : 'neutral') as BadgeTone,
      href: `/case/${caseId}/docs/${d.id}`,
      at: d.createdAt,
    })),
  ]);
}
