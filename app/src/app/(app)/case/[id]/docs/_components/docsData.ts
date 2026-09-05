'use client';

/**
 * 文件解读页的数据层：真接口调用 + 演示案件的 mock 适配。
 *
 * 【立这一层的由头】这一页此前对**任何 caseId** 都渲染 `mockDocs`——真实用户点进自己案子的
 * 文件解读页，读到的是「星曜网络」的解除通知与协商协议。后来改成真实案件一律空态，
 * 那是因为 company_docs 当时没有任何写入路径；现在 doc_submit 把通路接上了，这里改成现查。
 *
 * 接口形状取自同仓路由实现：
 *   GET /api/v1/cases/{id}/docs   已解读的来文（不含原文与逐条发现）
 *   GET /api/v1/docs/{id}         单份解读的全文与逐条发现
 */

import type { AnnotatedDoc, AnnotatedRiskFlag } from '@/app/_mock/docs-drafts';
import type { CompanyDocType, RiskFlag } from '@/app/_mock/types';
import { apiFetch } from '@/app/_ui/api';

/** 后端行的形状（照 lib/docs/read.ts 的 DocListItem） */
export interface ApiDocRow {
  id: number;
  case_id: number;
  file_id: number;
  doc_type: string | null;
  advice: string | null;
  advice_detail: string | null;
  risk_flags: RiskFlag[];
  title_line: string | null;
  source_name: string | null;
  created_at: string;
}

/** 详情行（照 DocDetail）：多出原文、整体判断与逐条发现 */
export interface ApiDocDetail extends ApiDocRow {
  ocr_text: string | null;
  summary: string | null;
  model: string | null;
  reviewed_at: string | null;
  findings: {
    id: number;
    clause_ref: string | null;
    severity: string;
    issue: string | null;
    basis: string | null;
    suggestion: string | null;
    negotiation_tip: string | null;
    status: string;
    rule_id: string | null;
  }[];
}

/**
 * 工具面的种类词表 → 页面的种类词表。
 * 工具那侧只有四档（解除通知 / 协议 / 调岗通知 / 其他），页面这侧的徽标词表是六档，
 * 「协议」在页面上一直叫「协商协议」。**这个对应关系只在这一处**：
 * 让每个渲染点自己判一次的形态是，同一份文件在列表里叫「协议」、在详情页叫「协商协议」。
 */
const DOC_TYPE_MAP: Record<string, CompanyDocType> = {
  解除通知: '解除通知',
  协议: '协商协议',
  协商协议: '协商协议',
  调岗通知: '调岗通知',
  PIP: 'PIP',
  警告: '警告',
  其他: '其他',
};

function toDocType(raw: string | null): CompanyDocType {
  if (raw && DOC_TYPE_MAP[raw]) return DOC_TYPE_MAP[raw];
  // 认不出的按「其他」渲染，但要出声——静默改归类会让用户找不到自己那份
  if (raw) console.warn('[docs] 未知的来文种类，按「其他」渲染：', raw);
  return '其他';
}

/**
 * 库里的时间列是 canonical 串（UTC、空格分隔、**没有时区标记**，见 lib/db/time）。
 * 直接丢给 `new Date()` 会按浏览器本地时区解析——在 +08:00 的机器上整份档案的时间
 * 一律早八小时，而页面上看起来完全正常。所以在这里补上 T 与 Z 再交给格式化。
 */
function toIso(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

const ADVICE_VALUES: readonly AnnotatedDoc['advice'][] = ['签', '不签', '改签', '待定'];

/**
 * 认不出的结论按「待定」渲染。往「待定」错是有方向的：
 * 把「不签」错成「签」，用户会照着签下去。
 */
function toAdvice(raw: string | null): AnnotatedDoc['advice'] {
  return raw && (ADVICE_VALUES as readonly string[]).includes(raw)
    ? (raw as AnnotatedDoc['advice'])
    : '待定';
}

const LEVELS: readonly RiskFlag['level'][] = ['高', '中', '低'];

function toFlag(flag: RiskFlag): AnnotatedRiskFlag {
  return {
    quote: flag.quote,
    level: (LEVELS as readonly string[]).includes(flag.level) ? flag.level : '低',
    note: flag.note,
    // 法条卡片只有演示数据挂得上（那份是人工按引文配的）。真解读的依据在逐条发现的
    // basis 字段里，是一串法条编号而不是逐字原文——**不拿它冒充逐字法条卡**。
    laws: [],
  };
}

/** 页面只认这个形状，不认后端字段名，也不认数据是真是假 */
export function toDocView(row: ApiDocRow): AnnotatedDoc {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    fileId: String(row.file_id),
    // 标题优先取原文第一行（《解除劳动合同协议书》这类），其次是证据库里的文件名，
    // 最后才退到种类——退到种类时同类的几份在列表里长得一样，所以它是兜底不是首选。
    title: row.title_line ?? row.source_name ?? toDocType(row.doc_type),
    docType: toDocType(row.doc_type),
    ocrText: '',
    riskFlags: row.risk_flags.map(toFlag),
    advice: toAdvice(row.advice),
    adviceDetail: row.advice_detail ?? '',
    createdAt: toIso(row.created_at),
    fileName: row.source_name ?? '粘贴的原文',
  };
}

export function toDocDetailView(row: ApiDocDetail): AnnotatedDoc {
  return { ...toDocView(row), ocrText: row.ocr_text ?? '' };
}

export async function fetchDocs(caseId: string): Promise<AnnotatedDoc[]> {
  const res = await apiFetch<{ docs: ApiDocRow[] }>(`/cases/${caseId}/docs`);
  return res.docs.map(toDocView);
}

export async function fetchDoc(docId: string): Promise<ApiDocDetail> {
  const res = await apiFetch<{ doc: ApiDocDetail }>(`/docs/${docId}`);
  return res.doc;
}
