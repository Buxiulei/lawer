// app/src/lib/docs/read.ts
// 来文解读结果的读出口（doc_list / doc_get，以及网页「文件解读」页）。
//
// 三张表在这之前是**建好了却没有任何生产写入路径**的空表，页面因此恒渲染演示数据。
// 读侧与写侧（review.ts）共用这里的行形状：页面、MCP、REST 三个出口读到的是同一份字段，
// 各自再拼一遍的形态是——同一份解读在页面上是「改签」、在 agent 那里是「待定」。
import type { Database } from 'better-sqlite3';

/** 一处风险条款。字段名与网页 RiskFlag 一致（quote 用于在原文里高亮）。 */
export interface RiskFlag {
  quote: string;
  level: '高' | '中' | '低';
  note: string;
}

/** 逐条审查发现（review_findings 的一行）。 */
export interface DocFinding {
  id: number;
  clause_ref: string | null;
  severity: string;
  issue: string | null;
  basis: string | null;
  suggestion: string | null;
  negotiation_tip: string | null;
  status: string;
  /** 命中规则库时回指规则 id；纯模型发现为 null */
  rule_id: string | null;
}

/** 列表行：不含全文与逐条发现，只够渲染一张卡片。 */
export interface DocListItem {
  id: number;
  case_id: number;
  file_id: number;
  doc_type: string | null;
  advice: string | null;
  advice_detail: string | null;
  risk_flags: RiskFlag[];
  /**
   * 原文第一行（截断）。**不是全文**：列表要有个能认出「这是哪一份」的标题，
   * 而这张表没有 title 列——文件的第一行通常就是它的名字（《解除劳动合同协议书》）。
   * 拿 doc_type 当标题的形态是：三份解除通知在列表里长得一模一样。
   */
  title_line: string | null;
  /**
   * 这份文件在证据库里的名字（同案同 file_id 的证据条目）；直接粘进来的原文没有，为 null。
   * 用户找的是「我传上去的那个文件」，认的是文件名。
   */
  source_name: string | null;
  created_at: string;
}

/** 详情：列表行 + 原文 + 本次审查的整体判断 + 逐条发现。 */
export interface DocDetail extends DocListItem {
  ocr_text: string | null;
  summary: string | null;
  model: string | null;
  reviewed_at: string | null;
  findings: DocFinding[];
}

interface DocRow {
  id: number;
  case_id: number;
  file_id: number;
  doc_type: string | null;
  ocr_text: string | null;
  risk_flags_json: string | null;
  advice: string | null;
  advice_detail: string | null;
  source_name: string | null;
  created_at: string;
}

/** 标题行的长度上限：卡片一行放得下，多了会把列表撑成一堵字墙。 */
const TITLE_LINE_MAX = 40;

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > TITLE_LINE_MAX ? `${line.slice(0, TITLE_LINE_MAX)}…` : line;
}

/**
 * risk_flags_json 解析。**坏 JSON 回空数组而不是抛错**：这一列是给页面高亮用的派生数据，
 * 正本是 review_findings；为一列渲染附属数据把整页读崩，代价与收益完全不成比例。
 */
function parseFlags(json: string | null): RiskFlag[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RiskFlag[]) : [];
  } catch {
    return [];
  }
}

const DOC_COLUMNS =
  `d.id AS id, d.case_id AS case_id, d.file_id AS file_id, d.doc_type AS doc_type,
   d.ocr_text AS ocr_text, d.risk_flags_json AS risk_flags_json, d.advice AS advice,
   d.advice_detail AS advice_detail, d.created_at AS created_at,
   (SELECT name FROM evidence WHERE file_id = d.file_id AND case_id = d.case_id ORDER BY id LIMIT 1)
     AS source_name`;

function toListItem(row: DocRow): DocListItem {
  return {
    id: row.id,
    case_id: row.case_id,
    file_id: row.file_id,
    doc_type: row.doc_type,
    advice: row.advice,
    advice_detail: row.advice_detail,
    risk_flags: parseFlags(row.risk_flags_json),
    title_line: firstLine(row.ocr_text),
    source_name: row.source_name,
    created_at: row.created_at,
  };
}

/**
 * 案件名下已解读的来文，新的在前。
 *
 * 归属由 cases.user_id 判，**不是**由 company_docs 自己判：这张表没有 user_id 列，
 * 拿 case_id 直接查等于谁知道案件号谁就能读。
 */
export function listDocs(db: Database, caseId: number, userId: number): DocListItem[] {
  const rows = db
    .prepare(
      `SELECT ${DOC_COLUMNS} FROM company_docs d
        WHERE d.case_id = ? AND d.case_id IN (SELECT id FROM cases WHERE user_id = ?)
        ORDER BY d.id DESC`,
    )
    .all(caseId, userId) as DocRow[];
  return rows.map(toListItem);
}

/**
 * 单份解读。**别人的与不存在的一律回 null**（调用方据此回同一个 404）：
 * 区分开就能拿连号的 doc_id 探测别人解读过什么文件。
 */
export function getDoc(db: Database, docId: number, userId: number): DocDetail | null {
  if (!Number.isInteger(docId) || docId <= 0) return null;
  const row = db
    .prepare(
      `SELECT ${DOC_COLUMNS} FROM company_docs d
        WHERE d.id = ? AND d.case_id IN (SELECT id FROM cases WHERE user_id = ?)`,
    )
    .get(docId, userId) as DocRow | undefined;
  if (!row) return null;

  // 一份文件可被反复审查，取最近一次（contract_reviews 每次审查各自成行，留得住历史结论）。
  const review = db
    .prepare(
      `SELECT id, model, reviewed_at, summary FROM contract_reviews
        WHERE company_doc_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(row.id) as { id: number; model: string | null; reviewed_at: string | null; summary: string | null } | undefined;

  const findings = review
    ? (db
        .prepare(
          `SELECT id, clause_ref, severity, issue, basis, suggestion, negotiation_tip, status, rule_id
             FROM review_findings WHERE review_id = ? ORDER BY id`,
        )
        .all(review.id) as DocFinding[])
    : [];

  return {
    ...toListItem(row),
    ocr_text: row.ocr_text,
    summary: review?.summary ?? null,
    model: review?.model ?? null,
    reviewed_at: review?.reviewed_at ?? null,
    findings,
  };
}
