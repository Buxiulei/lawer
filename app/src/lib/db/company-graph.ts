// app/src/lib/db/company-graph.ts
// 图谱**只读**取数：company_profiles / company_relations / company_litigation /
// company_watches / company_watch_events 五张表（spec §6：lib/db 是唯一 SQL 层）。
// 表结构见 migrate.ts。写入侧不在这里——采集与导入是另一张工单的事。
//
// 这一层不做归属校验，只忠实读；「这个案件是不是这个用户的」由调用方（lib/graph/build
// 的调用点，即 API 路由）先过 lib/cases 的归属校验，同 lib/db/cases.ts 的分工。
import type { Database } from 'better-sqlite3';

export interface CompanyProfileRow {
  id: number;
  case_id: number;
  name: string;
  uscc: string | null;
  role: string;
  reg_capital: string | null;
  legal_rep: string | null;
  risk_notes: string | null;
  sources_json: string | null;
  investigated_at: string | null;
  created_at: string;
}

export interface CompanyRelationRow {
  id: number;
  from_profile_id: number;
  to_profile_id: number;
  relation: string;
  evidence_url: string | null;
  confidence: string;
  created_at: string;
}

/** 一个主体在本案里的监控档位。同一主体可能被开了多个盯梢，取最强的那档由上层决定。 */
export interface ProfileTierRow {
  company_profile_id: number;
  tier: string;
  status: string;
}

export interface ProfileEventRow {
  id: number;
  company_profile_id: number;
  kind: string;
  severity: string;
  detail: string | null;
  detected_at: string;
}

export interface ProfileCountRow {
  company_profile_id: number;
  n: number;
}

export function listProfiles(db: Database, caseId: number): CompanyProfileRow[] {
  return db
    .prepare(
      `SELECT id, case_id, name, uscc, role, reg_capital, legal_rep,
              risk_notes, sources_json, investigated_at, created_at
         FROM company_profiles
        WHERE case_id = ?
        ORDER BY id`,
    )
    .all(caseId) as CompanyProfileRow[];
}

/**
 * 关系边。两端都必须落在**本案**的主体上——边表自己带 case_id，但端点是外键，
 * 跨案的脏边（历史导入出错）会让图上冒出一个本案没有的节点。这里用 JOIN 兜住：
 * 端点不在本案主体集合里的边直接不返回，而不是返回后在上层"发现指不到就丢"——
 * 丢在上层意味着每个新调用点都要重记一次这条规则。
 */
export function listRelations(db: Database, caseId: number): CompanyRelationRow[] {
  return db
    .prepare(
      `SELECT r.id, r.from_profile_id, r.to_profile_id, r.relation,
              r.evidence_url, r.confidence, r.created_at
         FROM company_relations r
         JOIN company_profiles pf ON pf.id = r.from_profile_id AND pf.case_id = r.case_id
         JOIN company_profiles pt ON pt.id = r.to_profile_id   AND pt.case_id = r.case_id
        WHERE r.case_id = ?
        ORDER BY r.id`,
    )
    .all(caseId) as CompanyRelationRow[];
}

/** 只取挂到了主体上的盯梢（company_profile_id 可空：手输公司名开盯的不进图谱，图上没有它的节点）。 */
export function listProfileTiers(db: Database, caseId: number): ProfileTierRow[] {
  return db
    .prepare(
      `SELECT company_profile_id, tier, status
         FROM company_watches
        WHERE case_id = ? AND company_profile_id IS NOT NULL
        ORDER BY id`,
    )
    .all(caseId) as ProfileTierRow[];
}

/**
 * 监控事件。经 company_watches 落到主体上；挂不到主体的盯梢（company_profile_id 为空）
 * 的事件不返回——图上没有它的节点，这条事件无处可挂。
 */
export function listProfileEvents(db: Database, caseId: number): ProfileEventRow[] {
  return db
    .prepare(
      `SELECT e.id, w.company_profile_id AS company_profile_id,
              e.kind, e.severity, e.detail, e.detected_at
         FROM company_watch_events e
         JOIN company_watches w ON w.id = e.watch_id
        WHERE w.case_id = ? AND w.company_profile_id IS NOT NULL
        ORDER BY e.detected_at DESC, e.id DESC`,
    )
    .all(caseId) as ProfileEventRow[];
}

/**
 * 每个主体的**劳动争议**入档条数。
 *
 * 【不按年限截断，这是个诚实取舍】mock 的字段注释原写「近 5 年」。真数据里
 * `judged_at` 大量为空（只有案号没有全文的条目照样入档，见 migrate.ts 该表注释），
 * 按 judged_at 卡 5 年会把这些行整批筛掉 ⇒ 涉诉多的公司显示得比实际干净。
 * 少报风险比多报风险贵，所以这里不截断，改由界面文案说清口径（"已入档"）。
 */
export function laborLitigationCounts(db: Database, caseId: number): ProfileCountRow[] {
  return db
    .prepare(
      `SELECT l.company_profile_id AS company_profile_id, COUNT(*) AS n
         FROM company_litigation l
         JOIN company_profiles p ON p.id = l.company_profile_id
        WHERE p.case_id = ? AND l.is_labor = 1
        GROUP BY l.company_profile_id`,
    )
    .all(caseId) as ProfileCountRow[];
}
