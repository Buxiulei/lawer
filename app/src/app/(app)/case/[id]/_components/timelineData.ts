'use client';

/**
 * 卷宗栏时间线的数据层：真接口调用 + demo（演示案件）的 mock 适配。
 * 组件只认这里的视图类型，不认后端字段名，也不认数据是真是假。
 *
 * 【立这一层的由头】卷宗栏那一块时间线此前渲染的是 `_mock/demo` 的 demoTimeline——
 * 写死的二十条演示事件，caseId 这个参数在那个组件里一次都没被用来取数。
 * 与 RecentRecords / Dashboard 当年那个形态逐字同款：页面照常渲染、一处报错都没有，
 * 只有打开它的人看到的每一条都不是自己的事。
 *
 * 接口形状取自同仓路由实现，一条新端点都没为读侧加：
 *   GET   /api/v1/cases/{id}?timeline_limit=200   档案 + 时间线整行（含 source_tier / event_type）
 *   POST  /api/v1/cases/{id}/timeline             记一条（只追加）
 *   PATCH /api/v1/cases/{id}/timeline/{eventId}   补选类型（全表唯一可改的那一列）
 */

import { demoTimeline } from '@/app/_mock/demo';
import { apiFetch } from '@/app/_ui/api';
import { DEFAULT_SOURCE_TIER, normalizeSourceTier, type SourceTier } from '@/lib/cases/source-tier';

/** 时间线一条事件在屏幕上需要的全部东西。后端字段名不出这一层。 */
export interface TimelineEventView {
  id: string;
  happenedAt: string;
  /** 四类之一；后端将来多一类时照原样渲染（见 toTimelineView） */
  kind: string;
  title: string;
  detail: string;
  /**
   * 登记时选的「这条记录是什么」。null = 没人选过——**这正是「选类型」那个小操作出现的条件**。
   * 它与"这一类不分型"是两回事：后者由领域包 timelineEventTypes[kind] 为空数组表达。
   */
  eventType: string | null;
  /**
   * 来源四档。**null = 认不出**（库里写坏了，或旧后端没这一列），渲染成〔未记录〕——
   * 悄悄折成「自述」的形态是：一行脏数据与一条真的自述事实在屏幕上完全同形。
   * 误差方向偏向"少认"：宁可标成没记录，不可把没支撑的说法渲染成有档位。
   */
  sourceTier: SourceTier | null;
  /** 这一条靠哪几份材料记下来的（引用桥用）。真接口不回这一格，恒空数组。 */
  evidenceIds: string[];
}

/** GET /cases/{id} 回包里时间线那一段的行（照 lib/db/cases.TimelineEventRow） */
interface ApiTimelineRow {
  id: number;
  happened_at: string;
  kind: string;
  title: string;
  detail: string | null;
  source_tier?: string;
  event_type?: string | null;
}

/**
 * 后端行 → 视图。**认不出的 kind 照原样带过去**，不折成四类里的某一档：
 * 折一下换来的是"枚举收口"，代价是库里明明是别的类别、屏幕上却写着另一个词，
 * 而页面不报错、条数也对（同 dashboardData.toDeadline 那条口径）。
 */
export function toTimelineView(row: ApiTimelineRow): TimelineEventView {
  return {
    id: String(row.id),
    happenedAt: row.happened_at,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? '',
    eventType: row.event_type ?? null,
    sourceTier: normalizeSourceTier(row.source_tier),
    evidenceIds: [],
  };
}

/**
 * 这个案件的时间线。取满 200（后端上限）而不是默认的 50：
 * 卷宗栏那一块要给出"共 N 条"，取少了那个数会比真的小，而屏幕上看不出任何区别。
 */
export async function fetchTimeline(caseId: string): Promise<TimelineEventView[]> {
  const detail = await apiFetch<{ timeline: ApiTimelineRow[] }>(
    `/cases/${caseId}?timeline_limit=200`,
  );
  return detail.timeline.map(toTimelineView);
}

/** 「记一件事」那张表单收上来的东西。字段名按表单说话，映射到端点契约在 createEvent 里做。 */
export interface NewEventInput {
  kind: string;
  /** 'YYYY-MM-DD'；服务端按 ISO8601 解析后由 SQL 归一 */
  happenedAt: string;
  title: string;
  detail: string;
  /** 没选（或这一类不分型）时传 null —— 这一格整个不进请求体 */
  eventType: string | null;
}

/**
 * 记一条。**source_tier 不由表单给**：网页登记的就是当事人自己的说法，
 * 档位由服务端缺省成最弱的那一档。让用户在这里选档位的形态是——
 * 一个刚把聊天记录截图存进证据库的人，顺手把这条事件标成「书证」，
 * 而要件表据此判它"成立"，庭上却拿不出与这条事件对应的那份原件。
 */
export async function createEvent(
  caseId: string,
  input: NewEventInput,
): Promise<TimelineEventView> {
  const reply = await apiFetch<{ event: ApiTimelineRow }>(`/cases/${caseId}/timeline`, {
    method: 'POST',
    body: {
      kind: input.kind,
      happened_at: input.happenedAt,
      title: input.title,
      // 空详情不传 null 也不传空串：这一格本来就是可选的
      ...(input.detail.trim() ? { detail: input.detail.trim() } : {}),
      // 不选类型 = 整个不传（服务端把空串与缺席当同一件事，但少发一格更贴近"没被问到"）
      ...(input.eventType ? { event_type: input.eventType } : {}),
    },
  });
  return toTimelineView(reply.event);
}

/** 补选（或改写）一条既有事件的类型。空串 = 取消这一格。 */
export async function setEventType(
  caseId: string,
  eventId: string,
  eventType: string,
): Promise<TimelineEventView> {
  const reply = await apiFetch<{ event: ApiTimelineRow }>(
    `/cases/${caseId}/timeline/${eventId}`,
    { method: 'PATCH', body: { event_type: eventType } },
  );
  return toTimelineView(reply.event);
}

/**
 * 刚记下的那条放到列表**最前面**。
 *
 * 【为什么是头插而不是重新取一遍】整页重取的形态是：用户点完「存下来」要等第二趟请求回来
 * 才看得见自己刚写的那句话，而那一趟可能失败——于是"存成了"与"没存成"在屏幕上同形。
 * 头插用的是回包里那一行（服务端落库后的真身，含它给的 id 与档位），不是表单里那份草稿。
 *
 * 【为什么不在这里排序】渲染那一层按 happenedAt 倒序排（见 CaseTimeline）。
 * 这里再排一次的形态是两处各有一份顺序口径，哪天改一处就出现"列表顺序取决于你是不是刚记过一条"。
 */
export function prependEvent(
  list: readonly TimelineEventView[],
  created: TimelineEventView,
): TimelineEventView[] {
  return [created, ...list.filter((e) => e.id !== created.id)];
}

/** 改完类型的那一行就地换掉（id 不变）。取不到对应 id 时原样返回，不凭空插一条。 */
export function replaceEvent(
  list: readonly TimelineEventView[],
  updated: TimelineEventView,
): TimelineEventView[] {
  return list.map((e) => (e.id === updated.id ? updated : e));
}

/**
 * 演示案件走这条，一次网络请求都不发（同 dashboardData.demoDashboard 的分工）。
 * 演示数据只有这一个函数读得到——组件那一侧一个 `_mock` 都不 import，
 * 于是"真实案件渲染出演示事件"这件事在结构上做不到。
 */
export function demoEvents(): TimelineEventView[] {
  return demoTimeline.map((e) => ({
    id: e.id,
    happenedAt: e.happenedAt,
    kind: e.kind,
    title: e.title,
    detail: e.detail,
    // 演示数据早于这两列落地，两格都没有。
    // · 类型：照实说"没人选过"。**演示态不会因此冒出「选类型」那个小操作**——
    //   演示案件没有 cases 行，两个写入口在那一屏一律不渲染（CaseTimeline 的 canWrite）。
    //   所以这几条只是不带类型标签而已。
    // · 档位：取**缺省档**，而不是 null。这两个值在屏幕上是两句不同的话：〔未记录〕说的是
    //   "库里根本没有这一项"，〔自述〕说的是"有，但只有当事人一个人的说法"。演示的那二十条
    //   正是当事人自己讲出来的经过，落成真数据时服务端给的也正是这一档（DDL 默认值同一个字面量）。
    eventType: null,
    sourceTier: DEFAULT_SOURCE_TIER,
    evidenceIds: e.evidenceIds,
  }));
}

/* ── 演示 / 真实这道岔口 ───────────────────────────────────── */

/**
 * 开屏那一刻手里有什么。演示案件同步就有（不闪一帧骨架），真实案件是 null＝**还在读**。
 *
 * 【为什么它和 loadTimeline 不写在组件的 effect 里】写成 effect 里一句 `if (demo)` 的形态是：
 * 把它改成恒真（真实案件也走演示数据、一次请求都不发），整套判据照绿——本仓没有 jsdom，
 * 组件的 effect 在判据里推不动。岔口搬到这两个纯函数上，就能拿一个 fetch 桩把它数出来。
 */
export function initialTimeline(demo: boolean): TimelineEventView[] | null {
  return demo ? demoEvents() : null;
}

/**
 * 这一屏该怎么拿时间线。**这是"演示走 mock、真实走接口"的唯一判定点。**
 *
 * @param demo 演示案件。它没有 cases 行，去请求只会换回一条 404。
 */
export function loadTimeline(caseId: string, demo: boolean): Promise<TimelineEventView[]> {
  return demo ? Promise.resolve(demoEvents()) : fetchTimeline(caseId);
}
