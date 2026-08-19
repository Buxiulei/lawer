// app/src/lib/db/evidence.ts
// files / evidence / attestations 三表的 SQL 封装（spec §6：lib/db 是唯一 SQL 层）。
// 领域编排在 lib/evidence，本文件只管取数存数，不含业务判断。
//
// 时间列一律不在应用层赋值，交给 DDL 的 datetime('now') 默认值（ADR-002）。
import type { Database } from 'better-sqlite3';

export interface FileRow {
  id: number;
  sha256: string;
  size: number;
  mime: string | null;
  enc_path: string;
  created_at: string;
}

/** evidence 一行 + 其文件的哈希/大小/类型（出证要用，避免调用方再查一次） */
export interface EvidenceDetailRow {
  id: number;
  case_id: number;
  user_id: number;
  file_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  original_medium: string | null;
  status: string;
  created_at: string;
  sha256: string;
  size: number;
  mime: string | null;
}

export interface AttestationRow {
  id: number;
  evidence_id: number | null;
  order_no: string;
  user_realname_snapshot_enc: string | null;
  sha256: string;
  tsa_tst_b64: string | null;
  tsa_gen_time: string | null;
  tsa_serial: string | null;
  tsa_url: string | null;
  cert_pdf_file_id: number | null;
  status: string;
  created_at: string;
}

// ========== files ==========

export function findFileBySha256(db: Database, sha256: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256) as FileRow | undefined;
}

export function findFileById(db: Database, fileId: number): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
}

/**
 * 按内容哈希落一行。sha256 已存在时不覆盖、不报错，直接返回既有行——
 * 去重是本表的立身之本（spec §3.5 文件按 SHA256 去重存储），
 * ON CONFLICT DO NOTHING 让并发上传同一文件也只会有一行。
 */
export function insertFileIfAbsent(
  db: Database,
  params: { sha256: string; size: number; mime: string | null; encPath: string },
): { row: FileRow; inserted: boolean } {
  const info = db
    .prepare(
      `INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)
       ON CONFLICT(sha256) DO NOTHING`,
    )
    .run(params.sha256, params.size, params.mime, params.encPath);
  const row = findFileBySha256(db, params.sha256);
  if (!row) throw new Error(`files 落库后读不回来: sha256=${params.sha256}`);
  return { row, inserted: info.changes > 0 };
}

// ========== evidence ==========

export function insertEvidence(
  db: Database,
  params: {
    caseId: number;
    userId: number;
    fileId: number;
    name: string;
    category: string;
    provePurpose: string | null;
    originalMedium: string | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO evidence (case_id, user_id, file_id, name, category, prove_purpose, original_medium)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.caseId,
      params.userId,
      params.fileId,
      params.name,
      params.category,
      params.provePurpose,
      params.originalMedium,
    );
  return Number(info.lastInsertRowid);
}

export function findEvidenceDetail(db: Database, evidenceId: number): EvidenceDetailRow | undefined {
  return db
    .prepare(
      `SELECT e.*, f.sha256, f.size, f.mime
       FROM evidence e JOIN files f ON f.id = e.file_id
       WHERE e.id = ?`,
    )
    .get(evidenceId) as EvidenceDetailRow | undefined;
}

export function updateEvidenceStatus(db: Database, evidenceId: number, status: string): void {
  db.prepare('UPDATE evidence SET status = ? WHERE id = ?').run(status, evidenceId);
}

// ========== attestations ==========

export function findAttestationByEvidenceId(
  db: Database,
  evidenceId: number,
): AttestationRow | undefined {
  return db
    .prepare('SELECT * FROM attestations WHERE evidence_id = ? ORDER BY id LIMIT 1')
    .get(evidenceId) as AttestationRow | undefined;
}

export function findAttestationByOrderNo(
  db: Database,
  orderNo: string,
): AttestationRow | undefined {
  return db.prepare('SELECT * FROM attestations WHERE order_no = ?').get(orderNo) as
    | AttestationRow
    | undefined;
}

/** 存证订单只追加（spec §7）：本文件不提供 delete，update 只填空字段见下。 */
export function insertAttestation(
  db: Database,
  params: {
    evidenceId: number;
    orderNo: string;
    sha256: string;
    realnameSnapshotEnc: string | null;
    status: string;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO attestations (evidence_id, order_no, user_realname_snapshot_enc, sha256, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.evidenceId,
      params.orderNo,
      params.realnameSnapshotEnc,
      params.sha256,
      params.status,
    );
  return Number(info.lastInsertRowid);
}

/**
 * 回填时间戳结果。`WHERE tsa_tst_b64 IS NULL` 是关键：
 * 已盖过章的订单不接受第二次写入，杜绝「重跑固化把原始时间戳改掉」——
 * 存证记录只追加不修改（spec §3.4），这里的 update 只用于把预留的空位填上。
 */
export function fillAttestationTimestamp(
  db: Database,
  params: {
    attestationId: number;
    tstB64: string;
    genTime: string;
    serial: string;
    tsaUrl: string;
    status: string;
  },
): boolean {
  const info = db
    .prepare(
      `UPDATE attestations
       SET tsa_tst_b64 = ?, tsa_gen_time = ?, tsa_serial = ?, tsa_url = ?, status = ?
       WHERE id = ? AND tsa_tst_b64 IS NULL`,
    )
    .run(
      params.tstB64,
      params.genTime,
      params.serial,
      params.tsaUrl,
      params.status,
      params.attestationId,
    );
  return info.changes > 0;
}

/** 回填《存证证明》PDF。同理只填空位，已出证的订单不被覆盖。 */
export function fillAttestationCert(
  db: Database,
  params: { attestationId: number; certPdfFileId: number; status: string },
): boolean {
  const info = db
    .prepare(
      `UPDATE attestations SET cert_pdf_file_id = ?, status = ?
       WHERE id = ? AND cert_pdf_file_id IS NULL`,
    )
    .run(params.certPdfFileId, params.status, params.attestationId);
  return info.changes > 0;
}

export function findAttestationById(db: Database, id: number): AttestationRow | undefined {
  return db.prepare('SELECT * FROM attestations WHERE id = ?').get(id) as
    | AttestationRow
    | undefined;
}
