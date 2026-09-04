// app/src/lib/evidence/attest.ts
// 存证固化编排（spec §8 evidence 行）：
//   evidence → 取文件 sha256 → /tsa 取时间戳 → 写 attestations
//   → /evidence-pdf 渲染证明 → /pades 签名 → PDF 落 files → 更新状态
//
// 全流程幂等：同一条 evidence 反复发起只会有一个订单号，中途失败可原地续跑。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { decryptField, encryptField } from '@/lib/crypto';
import { findCaseById } from '@/lib/db/cases';
import * as store from '@/lib/db/evidence';

import { storeBytes } from './files';
import * as sidecar from './sidecar-client';
import { SidecarError } from './sidecar-client';

/** 与 lib/auth/guard 的 domainFailure() 入参同形，可直接交给路由层转 HTTP */
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

function isFailure(value: unknown): value is DomainFailure {
  return typeof value === 'object' && value !== null && (value as DomainFailure).ok === false;
}

/** 不是自己的证据与不存在的证据返回同一个错误，调用方无从分辨（与 lib/cases 同口径） */
const NOT_FOUND = () => fail(404, 'EVIDENCE_NOT_FOUND', '证据不存在');

/** attestations.status 流转：pending → stamped（已盖时间戳）→ certified（已出证明） */
export const ATT_PENDING = 'pending';
export const ATT_STAMPED = 'stamped';
export const ATT_CERTIFIED = 'certified';

/** evidence.status 流转（spec §7 枚举） */
const EV_UPLOADED = '已上传';
const EV_STAMPED = '已固化';
const EV_CERTIFIED = '已出证';

/** 对外暴露的订单视图：绝不含实名快照密文本身 */
export interface AttestationView {
  id: number;
  order_no: string;
  evidence_id: number | null;
  sha256: string;
  status: string;
  tsa_gen_time: string | null;
  tsa_serial: string | null;
  tsa_url: string | null;
  cert_pdf_file_id: number | null;
  created_at: string;
}

function view(row: store.AttestationRow): AttestationView {
  return {
    id: row.id,
    order_no: row.order_no,
    evidence_id: row.evidence_id,
    sha256: row.sha256,
    status: row.status,
    tsa_gen_time: row.tsa_gen_time,
    tsa_serial: row.tsa_serial,
    tsa_url: row.tsa_url,
    cert_pdf_file_id: row.cert_pdf_file_id,
    created_at: row.created_at,
  };
}

/**
 * 订单号 `LAWER-ATT-<YYYYMMDD>-<16位hex>`。
 *
 * 随机段必须不可枚举：/verify/:orderNo 是**公开无鉴权**接口，订单号若可猜
 * （比如直接用自增 id），任何人都能顺着号段把全站存证记录扫一遍。64 bit 随机量
 * 使枚举不可行。日期段只为人工归档方便，不承担唯一性。
 */
export function generateOrderNo(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `LAWER-ATT-${d}-${crypto.randomBytes(8).toString('hex')}`;
}

/** 证件类型。与 users.cert_type 同一词表（见 migrate.ts）。 */
export const CERT_TYPE = { idCard: '身份证', passport: '护照' } as const;

/**
 * 证件号掩码。**按证件类型分规则，不按长度猜。**
 *
 * 【为什么不能一套规则通吃】原来只有一条「留头 4 尾 4」：
 *   18 位身份证 → 1101**********1234   露 8/18，合理
 *    9 位护照   → E123*5678             **露 8/9，等于没打码**
 * 而这个值印在《存证证明》PDF 上，是一份**对外出示的文件**。
 *
 * 【cert_type 缺失时按最保守规则】老数据（护照通道之前）没有这一列。
 * 此时**不猜**——猜错不报错，只是发出去的证上多露几位，没有任何人会发现。
 * 一律走护照那条更严的规则：露得少不会造成伤害，露得多会。
 * 误差方向必须偏向"少露"。
 */
export function maskCertNo(raw: string | null, certType?: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // 身份证：留头 4 尾 4（保持既有行为，已发出的证不改格式）
  if (certType === CERT_TYPE.idCard) {
    if (s.length <= 8) return '*'.repeat(s.length);
    return `${s.slice(0, 4)}${'*'.repeat(s.length - 8)}${s.slice(-4)}`;
  }
  // 护照 与 未知：留头 1 尾 2，其余打星
  if (s.length <= 3) return '*'.repeat(s.length);
  return `${s.slice(0, 1)}${'*'.repeat(s.length - 3)}${s.slice(-2)}`;
}

interface HolderSnapshot {
  real_name: string | null;
  id_card_masked: string | null;
  auth_status: string;
}

/**
 * 取实名快照。快照是「出证那一刻用户实名状态」的定格——用户事后改名或注销，
 * 已出的证明也不该跟着变，故整份存进 attestations 而不是出证时再查 users。
 */
function buildHolderSnapshot(db: Database, userId: number): HolderSnapshot {
  const row = db
    .prepare('SELECT real_name_enc, id_card_enc, auth_status, cert_type FROM users WHERE id = ?')
    .get(userId) as
    | { real_name_enc: string | null; id_card_enc: string | null; auth_status: string; cert_type: string | null }
    | undefined;
  if (!row) return { real_name: null, id_card_masked: null, auth_status: '未认证' };
  return {
    real_name: row.real_name_enc ? decryptField(row.real_name_enc) : null,
    id_card_masked: row.id_card_enc ? maskCertNo(decryptField(row.id_card_enc), row.cert_type) : null,
    auth_status: row.auth_status,
  };
}

/** sidecar 报错分级：503 是我方没配好（证书/key），502 是上游（TSA）不给力 */
function sidecarFailure(err: unknown): DomainFailure {
  if (err instanceof SidecarError) {
    if (err.status === 503) {
      return fail(503, 'ATTEST_UNAVAILABLE', `存证服务未就绪：${err.message}`);
    }
    return fail(502, 'ATTEST_UPSTREAM_FAILED', `存证上游失败：${err.message}`);
  }
  return fail(502, 'ATTEST_UPSTREAM_FAILED', `存证调用失败：${String(err)}`);
}

/**
 * 预留订单位（同步、原子）。
 *
 * better-sqlite3 是同步 API，同步事务内不会被同进程其它请求插入执行，
 * 故「查有没有 → 没有就建」这一段是原子的，并发重复发起只会有一个订单。
 * 注意这依赖单进程部署（当前 compose 就是一个 web 容器）；将来若多进程/多实例，
 * 需要给 attestations.evidence_id 加 UNIQUE 索引兜底（migrate 归 WS1）。
 */
function reserveAttestation(
  db: Database,
  ev: store.EvidenceDetailRow,
): store.AttestationRow {
  const reserve = db.transaction((): store.AttestationRow => {
    const existing = store.findAttestationByEvidenceId(db, ev.id);
    if (existing) return existing;
    const snapshot = buildHolderSnapshot(db, ev.user_id);
    const id = store.insertAttestation(db, {
      evidenceId: ev.id,
      orderNo: generateOrderNo(),
      sha256: ev.sha256,
      realnameSnapshotEnc: encryptField(JSON.stringify(snapshot)),
      status: ATT_PENDING,
    });
    const row = store.findAttestationById(db, id);
    if (!row) throw new Error(`attestations 落库后读不回来: id=${id}`);
    return row;
  });
  return reserve();
}

function reload(db: Database, id: number): store.AttestationRow {
  const row = store.findAttestationById(db, id);
  if (!row) throw new Error(`attestations 行消失: id=${id}`);
  return row;
}

/** 组装《存证证明》PDF 的 payload（形状见 sidecar/README.md） */
function buildPdfPayload(
  db: Database,
  ev: store.EvidenceDetailRow,
  att: store.AttestationRow,
  signerCn: string,
): unknown {
  const holder: HolderSnapshot = att.user_realname_snapshot_enc
    ? (JSON.parse(decryptField(att.user_realname_snapshot_enc)) as HolderSnapshot)
    : { real_name: null, id_card_masked: null, auth_status: '未认证' };
  const caseRow = findCaseById(db, ev.case_id);
  const base = process.env.PUBLIC_BASE_URL;

  return {
    order_no: att.order_no,
    generated_at: new Date().toISOString(),
    issuer: 'lawer 土八鼠',
    signer_cn: signerCn,
    verify_url: base ? `${base.replace(/\/+$/, '')}/verify/${att.order_no}` : '',
    status: att.tsa_gen_time ? 'stamped' : 'pending',
    holder: {
      real_name: holder.real_name,
      id_card_masked: holder.id_card_masked,
      auth_status: holder.auth_status,
      verified_at: null,
    },
    evidence: {
      case_title: caseRow?.title ?? null,
      name: ev.name,
      category: ev.category,
      prove_purpose: ev.prove_purpose,
      original_medium: ev.original_medium,
      mime: ev.mime,
      file_size: ev.size,
      uploaded_at: ev.created_at,
      sha256: ev.sha256,
    },
    timestamp: {
      gen_time: att.tsa_gen_time,
      serial: att.tsa_serial,
      tsa_url: att.tsa_url,
      tst_b64: att.tsa_tst_b64,
    },
  };
}

/**
 * 发起（或续跑）存证固化。
 *
 * 分三段推进，每段完成即落库：中途失败重发不会重来一遍，
 * 已盖的时间戳与已出的证明都不会被第二次覆盖（见 db/evidence 的 fill* 条件更新）。
 */
export async function attestEvidence(
  db: Database,
  input: { evidenceId: number; userId: number },
): Promise<Result<{ attestation: AttestationView }>> {
  if (!Number.isInteger(input.evidenceId) || input.evidenceId <= 0) return NOT_FOUND();
  const ev = store.findEvidenceDetail(db, input.evidenceId);
  if (!ev || ev.user_id !== input.userId) return NOT_FOUND();

  let att = reserveAttestation(db, ev);
  if (att.status === ATT_CERTIFIED && att.cert_pdf_file_id) {
    return { ok: true, attestation: view(att) };
  }

  // ── 第一段：可信时间戳 ──
  if (!att.tsa_tst_b64) {
    let ts: sidecar.TimestampResult;
    try {
      ts = await sidecar.requestTimestamp(ev.sha256);
    } catch (err) {
      return sidecarFailure(err);
    }
    store.fillAttestationTimestamp(db, {
      attestationId: att.id,
      tstB64: ts.tstB64,
      genTime: ts.genTime,
      serial: ts.serial,
      tsaUrl: ts.tsaUrl,
      status: ATT_STAMPED,
    });
    store.updateEvidenceStatus(db, ev.id, EV_STAMPED);
    att = reload(db, att.id);
  }

  // ── 第二段：渲染《存证证明》并签名 ──
  if (!att.cert_pdf_file_id) {
    let signed: Buffer;
    try {
      // 先问证书「你是谁」，再拿这个名字去渲染抬头的「签章主体」：
      // 印在证上的和 Acrobat 里点开签名看到的必须是同一个名字。
      // 取不到就整段不做——宁可这次不出证，也不出一份把签章主体写错的证。
      const signerCn = await sidecar.fetchSignerCn();
      const unsigned = await sidecar.renderEvidencePdf(buildPdfPayload(db, ev, att, signerCn));
      signed = await sidecar.signPdf(unsigned);
    } catch (err) {
      // 时间戳已经拿到并落库了，本次只是证明没出成；重发会从这一段续跑。
      return sidecarFailure(err);
    }
    const stored = storeBytes(db, signed, 'application/pdf');
    store.fillAttestationCert(db, {
      attestationId: att.id,
      certPdfFileId: stored.fileId,
      status: ATT_CERTIFIED,
    });
    store.updateEvidenceStatus(db, ev.id, EV_CERTIFIED);
    att = reload(db, att.id);
  }

  return { ok: true, attestation: view(att) };
}

/** 证据详情（含其存证订单，如果有） */
export function getEvidence(
  db: Database,
  input: { evidenceId: number; userId: number },
): Result<{ evidence: store.EvidenceDetailRow; attestation: AttestationView | null }> {
  if (!Number.isInteger(input.evidenceId) || input.evidenceId <= 0) return NOT_FOUND();
  const ev = store.findEvidenceDetail(db, input.evidenceId);
  if (!ev || ev.user_id !== input.userId) return NOT_FOUND();
  const att = store.findAttestationByEvidenceId(db, ev.id);
  return { ok: true, evidence: ev, attestation: att ? view(att) : null };
}

/** 公开验证页要展示的字段。刻意不含持证人身份——见 getVerification 注释。 */
export interface PublicVerification {
  order_no: string;
  status: string;
  sha256: string;
  created_at: string;
  evidence: { name: string; category: string; mime: string | null; file_size: number } | null;
  timestamp: {
    gen_time: string | null;
    serial: string | null;
    tsa_url: string | null;
    tst_b64: string | null;
  };
}

/**
 * 按订单号查存证记录，**公开无鉴权**（spec §8：`/verify/:no` 可离线复核哈希与时间戳）。
 *
 * 刻意不返回持证人姓名/证件号：本接口无鉴权，谁拿到订单号谁就能读。
 * 核验身份靠用户自己交出的《存证证明》PDF（那上面有实名快照），
 * 这里只回答「这个哈希在这个时刻已存在」——离线复核所需的信息一个不少，
 * 不需要的个人信息一个不给。
 */
export function getVerification(db: Database, orderNo: string): Result<PublicVerification> {
  const trimmed = (orderNo ?? '').trim();
  if (!trimmed) return fail(404, 'ORDER_NOT_FOUND', '存证订单不存在');
  const att = store.findAttestationByOrderNo(db, trimmed);
  if (!att) return fail(404, 'ORDER_NOT_FOUND', '存证订单不存在');

  const ev = att.evidence_id === null ? undefined : store.findEvidenceDetail(db, att.evidence_id);
  return {
    ok: true,
    order_no: att.order_no,
    status: att.status,
    sha256: att.sha256,
    created_at: att.created_at,
    evidence: ev
      ? { name: ev.name, category: ev.category, mime: ev.mime, file_size: ev.size }
      : null,
    timestamp: {
      gen_time: att.tsa_gen_time,
      serial: att.tsa_serial,
      tsa_url: att.tsa_url,
      tst_b64: att.tsa_tst_b64,
    },
  };
}

export { EV_UPLOADED, EV_STAMPED, EV_CERTIFIED, isFailure, fail };
