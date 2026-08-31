// app/src/lib/graph/build.ts
// 库里的五张 company_* 表 → CompanyGraph（契约见 ./contract）。
//
// 【这一层唯一的纪律：不编造】mock 里那些叙事字段（confidenceNote / updateNote）
// 在真数据里没有对应来源，于是这里给空串而不是拿一句通用话术填上。
// 一句"数据来源可靠、持续更新中"读起来比空白体面，但它是我们替用户签的字。
import type { Database } from 'better-sqlite3';

import * as store from '@/lib/db/company-graph';
import {
  GRAPH_TIER_LABELS,
  type CompanyGraph,
  type GraphEdge,
  type GraphEvent,
  type GraphNode,
  type GraphTier,
} from './contract';

/** company_watches.tier（migrate.ts 注释锁的枚举）→ 图谱圈层。 */
const TIER_OF_WATCH: Record<string, GraphTier> = {
  daily: 1,
  weekly: 2,
  archive: 3,
};

/**
 * 没有盯梢行的主体落到圈3。
 * 圈3 的文案是「只存快照，不定期看」——这正是"查了但没在盯"的准确描述，
 * 不是兜底占位。若哪天圈3 改成别的含义，这个默认值要跟着重判。
 */
const TIER_WITHOUT_WATCH: GraphTier = 3;

const CONFIDENCE_VALUES = ['高', '中', '低'] as const;
type Confidence = (typeof CONFIDENCE_VALUES)[number];

/**
 * confidence 在库里是无 CHECK 的 TEXT（migrate.ts 有意为之，值集由 lib 把关）。
 * 认不出的值一律降到「低」而不是抬到「高」：取不准时偏向报警（少信一条边
 * 只是少一条线索，多信一条边会让人拿着一条没证据的关系去开庭）。
 */
function normalizeConfidence(raw: string): Confidence {
  return (CONFIDENCE_VALUES as readonly string[]).includes(raw)
    ? (raw as Confidence)
    : '低';
}

/** 主体没有落判断说明时说清「没有」，不留空引用块，也不替调查员编一句。 */
const NOTE_WHEN_EMPTY = '这家还没有落进档案的判断说明，图上只有工商登记与关系边。';

/** meta.source：真数据的来源口径，与 demo 那句「脱敏示例」分开。 */
const REAL_SOURCE = '公开检索与裁判文书（本案档案内记录）';

export function buildCompanyGraph(db: Database, caseId: number): CompanyGraph | null {
  const profiles = store.listProfiles(db, caseId);
  // 一个主体都没有＝这案还没做过公司调查。返回 null 而不是空图：
  // 空图会渲染成一张什么都没有的画布，null 才走得到「调查完成后这里会生成图谱」。
  if (profiles.length === 0) return null;

  const ids = new Set(profiles.map((p) => p.id));

  // 同一主体开了多个盯梢时取**最强**的一档（daily 胜 weekly 胜 archive）。
  // 取最强而不是取最后一行：界面上圈层是"我们盯得多勤"的承诺，
  // 按行序取会让同一份数据因为插入顺序不同而显示成不同的承诺。
  const tierOf = new Map<number, GraphTier>();
  for (const w of store.listProfileTiers(db, caseId)) {
    if (!ids.has(w.company_profile_id)) continue;
    const tier = TIER_OF_WATCH[w.tier] ?? TIER_WITHOUT_WATCH;
    const prev = tierOf.get(w.company_profile_id);
    if (prev === undefined || tier < prev) tierOf.set(w.company_profile_id, tier);
  }

  const litigationOf = new Map<number, number>();
  for (const row of store.laborLitigationCounts(db, caseId)) {
    litigationOf.set(row.company_profile_id, row.n);
  }

  const rawEvents = store.listProfileEvents(db, caseId);
  const eventCountOf = new Map<number, number>();
  for (const e of rawEvents) {
    if (!ids.has(e.company_profile_id)) continue;
    eventCountOf.set(e.company_profile_id, (eventCountOf.get(e.company_profile_id) ?? 0) + 1);
  }

  const nodes: GraphNode[] = profiles.map((p) => ({
    id: String(p.id),
    name: p.name,
    role: p.role,
    tier: tierOf.get(p.id) ?? TIER_WITHOUT_WATCH,
    eventCount: eventCountOf.get(p.id) ?? 0,
    litigationCount: litigationOf.get(p.id) ?? 0,
    // 可选字段给 undefined 而不是空串：NodeSheet 用 `node.creditCode && …` 判在不在，
    // 空串虽然也是假值，但它会让"库里存了个空字符串"和"这列是 NULL"看起来一样。
    ...(p.uscc ? { creditCode: p.uscc } : {}),
    ...(p.legal_rep ? { legalRep: p.legal_rep } : {}),
    ...(p.reg_capital ? { regCapital: p.reg_capital } : {}),
    note: p.risk_notes?.trim() ? p.risk_notes : NOTE_WHEN_EMPTY,
  }));

  const edges: GraphEdge[] = store.listRelations(db, caseId).map((r) => ({
    from: String(r.from_profile_id),
    to: String(r.to_profile_id),
    relation: r.relation,
    confidence: normalizeConfidence(r.confidence),
    ...(r.evidence_url ? { evidenceUrl: r.evidence_url } : {}),
  }));

  const events: GraphEvent[] = rawEvents
    .filter((e) => ids.has(e.company_profile_id))
    .map((e) => ({
      id: String(e.id),
      nodeId: String(e.company_profile_id),
      happenedAt: e.detected_at,
      kind: e.kind,
      urgent: e.severity === 'urgent',
      // 表里没有独立的标题列，kind 就是这条事件的名字（「简易注销公告」这类）。
      // 抽屉里会连着日期再显示一次 kind，看着有点重复——但比现编一个标题诚实。
      title: e.kind,
      detail: e.detail ?? '',
    }));

  return {
    meta: {
      generated: earliest(profiles.map((p) => p.investigated_at ?? p.created_at)),
      updated: latest([
        ...profiles.map((p) => p.investigated_at ?? p.created_at),
        ...rawEvents.map((e) => e.detected_at),
      ]),
      source: REAL_SOURCE,
      // 这两个字段在 demo mock 里是调查员写的叙事，真数据没有对应来源。
      // 给空串＝如实说"没有这句话"，不拿通用话术填。目前没有组件渲染它们。
      confidenceNote: '',
      updateNote: '',
      tiers: GRAPH_TIER_LABELS,
    },
    nodes,
    edges,
    events,
  };
}

/**
 * 时间戳挑最早/最晚的一个。
 *
 * 全是 ISO/SQL 文本（ADR-002：时间戳一律留字符串不转 Date），同格式下字典序即时序。
 * 空数组不该发生（profiles 非空且 created_at NOT NULL），真发生时返回空串会让
 * 界面渲染出 `Invalid Date`——那是个看起来像 bug 其实是数据缺失的错误，
 * 所以这里直接抛：调用点少了一条不变量，比在界面上印一行乱码更该被人看见。
 */
function pick(values: string[], keepLeft: (a: string, b: string) => boolean): string {
  const usable = values.filter((v) => typeof v === 'string' && v.length > 0);
  if (usable.length === 0) {
    throw new Error(
      '图谱时间戳取不到：company_profiles 至少应有 created_at（NOT NULL DEFAULT）。' +
        '出现这条说明取数被改过或库被手改过，请检查 lib/db/company-graph.ts 的 SELECT 列。',
    );
  }
  return usable.reduce((acc, v) => (keepLeft(acc, v) ? acc : v));
}

const earliest = (values: string[]) => pick(values, (a, b) => a <= b);
const latest = (values: string[]) => pick(values, (a, b) => a >= b);
