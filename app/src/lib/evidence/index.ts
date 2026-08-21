// app/src/lib/evidence/index.ts
// 证据上传/SHA256 去重/加密落盘/TSA 固化编排（调 sidecar）。
// 跨模块只经本文件导出的函数接口（spec §3.2）。
//
// ── sidecar 调用契约（WS2 提供，详见 sidecar/README.md）──
// 基址取 env SIDECAR_URL（容器内 http://sidecar:8100，不映射宿主端口）。
// 出证链路顺序：/tsa 取时间戳 → /evidence-pdf 渲染未签名证明 → /pades 施加签名 → 落 files 表。
// 状态码：入参不合法 400/422；依赖未配置（无 key/无证书）503；上游 TSA/DashScope 报错 502。
//
// ⚠ /verify 是例外：验签**不通过也返回 200**，裁决在响应体的 `overall_ok` 字段。
//   把 200 当成"验过了"会让无效证据静默通过——这是仲裁场上会直接害到用户的错误，
//   调用方必须显式读 overall_ok，绝不能只判 res.ok。
//   本模块的封装见 sidecar-client.verifyPdf()，它返回的 passed 已经读过 overall_ok。
import type { Database } from 'better-sqlite3';

import { findCaseById } from '@/lib/db/cases';
import * as store from '@/lib/db/evidence';

import { fail, type Result } from './attest';
import { storeBytes } from './files';

export {
  attestEvidence,
  getEvidence,
  getVerification,
  generateOrderNo,
  type AttestationView,
  type DomainFailure,
  type PublicVerification,
  type Result,
} from './attest';
export { readBytes, storeBytes, type StoredFile } from './files';
export { SidecarError, verifyPdf, type VerifyVerdict } from './sidecar-client';
export {
  recheckVerification,
  resetRecheckQuota,
  type RecheckItem,
  type RecheckReport,
} from './recheck';

/** spec §7 evidence.category 枚举 */
export const EVIDENCE_CATEGORIES = [
  '合同',
  '工资',
  '社保',
  '考勤',
  '沟通记录',
  '公司文件',
  '录音',
  '其他',
] as const;

/** 上传单个文件建证据条目。文件本身按哈希去重，重复上传不重复占盘。 */
export function uploadEvidence(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    bytes: Buffer;
    name: string;
    mime: string | null;
    category?: string;
    provePurpose?: string | null;
    originalMedium?: string | null;
  },
): Result<{ evidence: store.EvidenceDetailRow; deduped: boolean }> {
  const caseRow = findCaseById(db, input.caseId);
  // 案件不存在与不是自己的案件同一个错误，与 lib/cases 同口径
  if (!caseRow || caseRow.user_id !== input.userId) {
    return fail(404, 'CASE_NOT_FOUND', '案件不存在');
  }
  if (input.bytes.length === 0) {
    return fail(400, 'EMPTY_FILE', '上传文件为空');
  }
  const name = input.name.trim();
  if (!name) {
    return fail(400, 'INVALID_NAME', '证据名称不能为空');
  }
  const category = input.category ?? '其他';
  if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(category)) {
    return fail(400, 'INVALID_CATEGORY', `category 只能是 ${EVIDENCE_CATEGORIES.join(' / ')}`);
  }

  const stored = storeBytes(db, input.bytes, input.mime);
  const evidenceId = store.insertEvidence(db, {
    caseId: input.caseId,
    userId: input.userId,
    fileId: stored.fileId,
    name,
    category,
    provePurpose: input.provePurpose?.trim() || null,
    originalMedium: input.originalMedium?.trim() || null,
  });
  const evidence = store.findEvidenceDetail(db, evidenceId);
  if (!evidence) throw new Error(`evidence 落库后读不回来: id=${evidenceId}`);
  return { ok: true, evidence, deduped: stored.deduped };
}
