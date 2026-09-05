'use client';

/**
 * 证据库的数据层：真接口调用 + demo（未登录 / demo 案件）的 mock 适配。
 * 页面组件只认这里的 EvidenceView，不认后端字段名，也不认数据是真是假。
 *
 * 接口形状取自 main 上的路由实现：
 *   GET  /api/v1/cases/{caseId}/evidence   列表（**只有元数据**，没有 sha256/大小/存证订单）
 *   GET  /api/v1/evidence/{id}             详情 + 存证订单
 *   POST /api/v1/evidence                  multipart 上传
 *   POST /api/v1/evidence/{id}/attest      固化（幂等，中途失败原地续跑）
 */

import { demoEvidence } from '@/app/_mock/demo';
import type { EvidenceCategory, EvidenceItem, EvidenceStatus } from '@/app/_mock/types';
import { apiFetch, apiUpload } from '@/app/_ui/api';

/** 存证订单（后端 AttestationView 的可展示子集） */
export interface AttestationInfo {
  orderNo: string;
  status: string;
  sha256: string;
  tsaGenTime: string | null;
  tsaSerial: string | null;
  /** 有值代表《存证证明》PDF 已经生成并落库 */
  certPdfFileId: number | null;
}

/** 一件材料的内容提取与简报（详情接口的 extraction 段）。列表阶段拿不到，为 null。 */
export interface ExtractionInfo {
  /** none / queued / running / done / failed */
  status: string;
  extractedAt: string | null;
  /** 已提取的正文（后端已截到 8000 字，truncated 为真时说明还有后文） */
  text: string;
  truncated: boolean;
  textChars: number;
  brief: EvidenceBriefView | null;
  briefVersion: number;
  mime: string | null;
}

/** 简报的固定 schema，与后端 lib/evidence/brief.ts 逐字同形。 */
export interface EvidenceBriefView {
  proves: string;
  key_facts: { when: string; who: string; what: string; quote: string; where: string }[];
  relation_to_claims: string;
  weaknesses: string[];
  suggested_followups: string[];
  citations: string[];
}

/** 提取方式。与后端 extraction_jobs.mode 同名同物。 */
export type ExtractMode = 'ocr' | 'asr' | 'video';

/** 一张提取报价。**拿到它没有扣任何钱**，确认才扣。 */
export interface ExtractQuote {
  quoteId: number;
  amount: number;
  units: number;
  unitLabel: string;
  unitPrice: number;
  basis: string;
  label: string;
  expiresAt: string;
}

/** 页面用的证据视图。列表阶段拿不到的字段为 null，打开详情时才补齐。 */
export interface EvidenceView {
  id: string;
  name: string;
  category: EvidenceCategory;
  provePurpose: string;
  originalMedium: string;
  status: EvidenceStatus;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
  attestation: AttestationInfo | null;
  /** 提取状态与简报；列表阶段为 null，打开详情时补齐 */
  extraction: ExtractionInfo | null;
  /** 详情（大小/哈希/订单）是否已经取回 */
  detailed: boolean;
}

const CATEGORIES: readonly EvidenceCategory[] = [
  '合同',
  '工资',
  '社保',
  '考勤',
  '沟通记录',
  '公司文件',
  '录音',
  '其他',
];

const STATUSES: readonly EvidenceStatus[] = ['已上传', '已固化', '已出证'];

/** 后端枚举与前端联合类型逐字一致；万一将来多出一个值，按最保守的「已上传」渲染 */
function toCategory(raw: string): EvidenceCategory {
  return CATEGORIES.includes(raw as EvidenceCategory) ? (raw as EvidenceCategory) : '其他';
}

function toStatus(raw: string): EvidenceStatus {
  return STATUSES.includes(raw as EvidenceStatus) ? (raw as EvidenceStatus) : '已上传';
}

/* ── 后端行的形状（照 lib/db/cases.EvidenceRow 与 lib/db/evidence.EvidenceDetailRow）── */

interface ApiEvidenceRow {
  id: number;
  case_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  status: string;
  created_at: string;
}

interface ApiEvidenceDetailRow extends ApiEvidenceRow {
  original_medium: string | null;
  sha256: string;
  size: number;
  mime: string | null;
}

interface ApiAttestation {
  order_no: string;
  status: string;
  sha256: string;
  tsa_gen_time: string | null;
  tsa_serial: string | null;
  cert_pdf_file_id: number | null;
}

function toAttestation(raw: ApiAttestation | null | undefined): AttestationInfo | null {
  if (!raw) return null;
  return {
    orderNo: raw.order_no,
    status: raw.status,
    sha256: raw.sha256,
    tsaGenTime: raw.tsa_gen_time,
    tsaSerial: raw.tsa_serial,
    certPdfFileId: raw.cert_pdf_file_id,
  };
}

function fromListRow(row: ApiEvidenceRow): EvidenceView {
  return {
    id: String(row.id),
    name: row.name,
    category: toCategory(row.category),
    provePurpose: row.prove_purpose ?? '',
    originalMedium: '',
    status: toStatus(row.status),
    sizeBytes: null,
    sha256: null,
    createdAt: row.created_at,
    attestation: null,
    extraction: null,
    detailed: false,
  };
}

interface ApiExtraction {
  extraction_status: string;
  extracted_at: string | null;
  extracted_text: string | null;
  truncated: boolean;
  extracted_text_chars: number;
  brief: EvidenceBriefView | null;
  brief_version: number;
  mime: string | null;
}

function toExtraction(raw: ApiExtraction | null | undefined): ExtractionInfo | null {
  if (!raw) return null;
  return {
    status: raw.extraction_status,
    extractedAt: raw.extracted_at,
    text: raw.extracted_text ?? '',
    truncated: raw.truncated,
    textChars: raw.extracted_text_chars,
    brief: raw.brief,
    briefVersion: raw.brief_version,
    mime: raw.mime,
  };
}

function fromDetailRow(
  row: ApiEvidenceDetailRow,
  attestation: ApiAttestation | null,
  extraction: ApiExtraction | null = null,
): EvidenceView {
  return {
    id: String(row.id),
    name: row.name,
    category: toCategory(row.category),
    provePurpose: row.prove_purpose ?? '',
    originalMedium: row.original_medium ?? '',
    status: toStatus(row.status),
    sizeBytes: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
    attestation: toAttestation(attestation),
    extraction: toExtraction(extraction),
    detailed: true,
  };
}

/* ── 真接口 ─────────────────────────────────────────────── */

export async function fetchEvidenceList(caseId: string): Promise<EvidenceView[]> {
  const res = await apiFetch<{ evidence: ApiEvidenceRow[] }>(
    `/cases/${encodeURIComponent(caseId)}/evidence`,
  );
  return res.evidence.map(fromListRow);
}

export async function fetchEvidenceDetail(evidenceId: string): Promise<EvidenceView> {
  const res = await apiFetch<{
    evidence: ApiEvidenceDetailRow;
    attestation: ApiAttestation | null;
    extraction: ApiExtraction | null;
  }>(`/evidence/${encodeURIComponent(evidenceId)}`);
  return fromDetailRow(res.evidence, res.attestation, res.extraction);
}

export interface UploadInput {
  caseId: string;
  file: File;
  name: string;
  category: EvidenceCategory;
  provePurpose: string;
  originalMedium: string;
}

export async function uploadEvidence(
  input: UploadInput,
  onProgress?: (ratio: number) => void,
): Promise<EvidenceView> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('case_id', input.caseId);
  form.append('name', input.name);
  form.append('category', input.category);
  if (input.provePurpose.trim()) form.append('prove_purpose', input.provePurpose.trim());
  if (input.originalMedium.trim()) form.append('original_medium', input.originalMedium.trim());

  const res = await apiUpload<{ evidence: ApiEvidenceDetailRow; deduped: boolean }>(
    '/evidence',
    form,
    { onProgress },
  );
  return fromDetailRow(res.evidence, null);
}

/**
 * 发起固化。后端一次调用走完「取时间戳 → 出《存证证明》→ 签名」三段；
 * 中间某段失败会带着已完成的部分返回错误，再点一次从断的地方续跑，不会重复出证。
 */
export async function attestEvidence(evidenceId: string): Promise<AttestationInfo> {
  const res = await apiFetch<{ attestation: ApiAttestation }>(
    `/evidence/${encodeURIComponent(evidenceId)}/attest`,
    { method: 'POST' },
  );
  return toAttestation(res.attestation)!;
}

/**
 * 问一次提取的价。**这一步不扣任何费用**，也不会开始提取——
 * 拿到 quoteId 再调 startExtraction 才确认扣费。
 */
export async function quoteExtraction(
  evidenceId: string,
  mode: ExtractMode,
): Promise<ExtractQuote> {
  const res = await apiFetch<{
    quote: {
      quote_id: number;
      amount: number;
      units: number;
      unit_label: string;
      unit_price: number;
      basis: string;
      label: string;
      expires_at: string;
    };
  }>(`/evidence/${encodeURIComponent(evidenceId)}/extract`, {
    method: 'POST',
    body: { mode },
  });
  const q = res.quote;
  return {
    quoteId: q.quote_id,
    amount: q.amount,
    units: q.units,
    unitLabel: q.unit_label,
    unitPrice: q.unit_price,
    basis: q.basis,
    label: q.label,
    expiresAt: q.expires_at,
  };
}

/** 确认这张报价：扣费并把提取排进队列。同一张报价重复确认不会扣第二笔、也不会排第二条队。 */
export async function startExtraction(
  evidenceId: string,
  mode: ExtractMode,
  quoteId: number,
): Promise<{ jobId: number; status: string; charged: number }> {
  const res = await apiFetch<{ job: { job_id: number; status: string; charged: number } }>(
    `/evidence/${encodeURIComponent(evidenceId)}/extract`,
    { method: 'POST', body: { mode, quote_id: quoteId } },
  );
  return { jobId: res.job.job_id, status: res.job.status, charged: res.job.charged };
}

/* ── demo 数据源（未登录或 demo 案件）───────────────────── */

/** demo 的存证编号就是 mock 里那串，验证页照样能点开看它的「无法验证」中性态 */
export function demoView(item: EvidenceItem): EvidenceView {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    provePurpose: item.provePurpose,
    originalMedium: item.originalMedium,
    status: item.status,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    createdAt: item.createdAt,
    attestation: item.attestationNo
      ? {
          orderNo: item.attestationNo,
          status: 'certified',
          sha256: item.sha256,
          tsaGenTime: item.createdAt,
          tsaSerial: null,
          certPdfFileId: 0,
        }
      : null,
    extraction: null,
    detailed: true,
  };
}

export function demoEvidenceViews(): EvidenceView[] {
  return demoEvidence.map(demoView);
}
