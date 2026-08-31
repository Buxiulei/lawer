// app/src/lib/evidence/recheck.ts
// 存证订单的**服务端实时复核**：不看库里存的结论，当场把原件和证明 PDF 重新算一遍。
//
// 与 getVerification 的分工：那个是轻量读库（页面首屏、离线复核用），
// 这个是重活——读盘、解密、复算哈希、调 sidecar 验签，故单独一条端点并带限流。
//
// ⚠ 两类失败必须分开，绝不能混（lib/evidence/index.ts 头部的 sidecar 契约）：
//   「验了但不通过」→ 本模块返回 ok:true + 该项 passed:false，这是对证据的裁决；
//   「没验成」（sidecar 挂了/网络不通）→ 返回 DomainFailure（502/503），**不是** passed:false。
// 把后者说成 passed:false 等于在公开验证页上诬告用户的证据无效——比漏判更害人。
//
// ⚠ report.checks[].detail 与 DomainFailure.message 会**原样渲染给匿名访客**
// （本端点公开无鉴权）。所以异常原文一律经 lib/errors/user-facing 的 toUserFacingError
// 转换：原文进服务端日志，出去的只有稳定错误码 + 三段式中文。结论（passed / 502 / 503）
// 一个都不变，换掉的只是那句话怎么说。
//
// ⚠ **我方抛的异常不是唯一脏源**：sidecar 回 200 的裁决体里，verdict.error 与
// verdict.signatures[].error 是它自己拼的裸 Python 异常原文（含服务器绝对路径、异常类名）。
// 按「上游永远可能给脏值」设防，故两道都要有：
//   ① 进 detail 前经同一个 toUserFacingError（verdictErrorTexts → 一次性落日志换文案）；
//   ② 出境前经 toPublicVerdict 白名单投影——上游将来新增什么字段都默认不出去。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { createIpQuota } from '@/lib/auth/ip-quota';
import * as store from '@/lib/db/evidence';
import { toUserFacingError } from '@/lib/errors/user-facing';

import { fail, type DomainFailure, type Result } from './attest';
import { readBytes } from './files';
import { SidecarError, verifyPdf, type VerifyVerdict } from './sidecar-client';

/**
 * 公开端点的防滥用桶：24h 内同一 IP 最多 30 次。
 * 与 lib/auth 的发码桶**各记各的**（createIpQuota 每次新建 Map）——
 * 核验证据的人和注册登录的人往往不是同一批，额度不该互相挤占。
 * 同样是内存计数、重启即清，定位是兜底而非主防线（理由见 ip-quota.ts）。
 */
const recheckQuota = createIpQuota(30);

/** 仅供单测隔离用例使用 */
export function resetRecheckQuota(): void {
  recheckQuota.reset();
}

export interface RecheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RecheckReport {
  order_no: string;
  /** 三项全过才为 true。任一项没过、或订单还没走完出证流程，都是 false。 */
  overall_ok: boolean;
  checks: RecheckItem[];
  /** sidecar 的完整裁决，供排障与展示细节；订单未出证时为 null */
  verdict: VerifyVerdict | null;
}

const CHECK_HASH = '哈希一致';
const CHECK_TST = 'TST 有效';
const CHECK_SIGNATURE = '签名有效';

function item(name: string, passed: boolean, detail: string): RecheckItem {
  return { name, passed, detail };
}

/** sidecar 报错分级：503 是我方没配好（证书/信任锚），502 是别的没验成 */
function sidecarFailure(err: unknown): DomainFailure {
  if (err instanceof SidecarError && err.status === 503) {
    const u = toUserFacingError(err, { code: 'RECHECK_UNAVAILABLE', where: 'recheck.verifyPdf' });
    return fail(503, u.code, u.message);
  }
  const u = toUserFacingError(err, { code: 'RECHECK_UPSTREAM_FAILED', where: 'recheck.verifyPdf' });
  return fail(502, u.code, u.message);
}

/**
 * 第一项：按 files 表把原件取回来复算 SHA-256，与 attestations.sha256 比对。
 *
 * readBytes 自己会校验「盘上密文解出来还是 files.sha256 那份」，
 * 所以这里再比一次 attestations.sha256 是查另一件事：**库内两处记录是否脱钩**
 * （文件行被改、或证据被换绑到别的文件）。两处都对，才叫原件没动过。
 */
function checkHash(db: Database, att: store.AttestationRow): RecheckItem {
  if (att.evidence_id === null) {
    return item(CHECK_HASH, false, '该订单没有关联证据条目，无法取回原件复算');
  }
  const ev = store.findEvidenceDetail(db, att.evidence_id);
  if (!ev) {
    return item(CHECK_HASH, false, '关联的证据条目已不存在，无法取回原件复算');
  }
  let actual: string;
  try {
    actual = crypto.createHash('sha256').update(readBytes(db, ev.file_id)).digest('hex');
  } catch (err) {
    // 文件缺失、密文被改、与 files.sha256 不符都走这里——都是「原件不可信」，不是服务故障
    const u = toUserFacingError(err, { code: 'EVIDENCE_READ_FAILED', where: 'recheck.checkHash' });
    return item(CHECK_HASH, false, u.message);
  }
  return actual === att.sha256
    ? item(CHECK_HASH, true, `原件 SHA-256 与存证记录一致：${att.sha256}`)
    : item(CHECK_HASH, false, `原件 SHA-256 与存证记录不符：存证 ${att.sha256}，实得 ${actual}`);
}

/** 每个签名都要过；一个都没有也算没过（未签名件绝不判通过） */
function everySignature(
  verdict: VerifyVerdict,
  pick: (row: Record<string, unknown>) => boolean,
): boolean {
  if (verdict.num_signatures <= 0) return false;
  return verdict.signatures.every(
    (row) => row !== null && typeof row === 'object' && pick(row as Record<string, unknown>),
  );
}

function checkTimestamp(verdict: VerifyVerdict, att: store.AttestationRow): RecheckItem {
  if (!att.tsa_tst_b64) {
    return item(CHECK_TST, false, '存证记录里没有 RFC3161 时间戳');
  }
  // 时间戳链要锚定到内置 GlobalSign AATL 根（sidecar 的 PIN 信任锚），且自身未被改动
  const ok = everySignature(
    verdict,
    (row) => row.timestamp_present === true && row.timestamp_intact === true && row.timestamp_trusted === true,
  );
  return ok
    ? item(CHECK_TST, true, `可信时间戳有效，签发于 ${att.tsa_gen_time ?? '（时间未记录）'}（${att.tsa_url ?? 'TSA 未记录'}）`)
    : item(CHECK_TST, false, '证明文件上的可信时间戳未通过校验（不存在、被改动或不可信任）');
}

/**
 * 裁决里**由 sidecar 自由书写**的文本：顶层 error 与每个签名行的 error。
 * 两处都是 `f"...: {e}"` 拼出来的 Python 异常原文，一个字都不许进 detail。
 * 这里只负责把它们收齐（可能不止一条），交给调用方一次性过边界。
 */
function verdictErrorTexts(verdict: VerifyVerdict): string[] {
  const texts: string[] = [];
  if (typeof verdict.error === 'string' && verdict.error !== '') texts.push(verdict.error);
  for (const row of Array.isArray(verdict.signatures) ? verdict.signatures : []) {
    if (row === null || typeof row !== 'object') continue;
    const rowError = (row as Record<string, unknown>).error;
    if (typeof rowError === 'string' && rowError !== '') texts.push(rowError);
  }
  return texts;
}

/**
 * @param errorCopy sidecar 自陈失败原因的**净化后文案**（它没自陈则为 null）。
 *   刻意只收文案不收原文：原文在 recheckVerification 就已经落日志、到不了这里。
 */
function checkSignature(verdict: VerifyVerdict, errorCopy: string | null): RecheckItem {
  const ok = everySignature(verdict, (row) => row.signature_ok === true);
  if (ok) {
    return item(CHECK_SIGNATURE, true, `《存证证明》上的 ${verdict.num_signatures} 个数字签名全部有效`);
  }
  return item(
    CHECK_SIGNATURE,
    false,
    errorCopy ?? '《存证证明》数字签名未通过校验：签名无效、证书链不可信，或文件在签署后被改动',
  );
}

/** 允许离开服务器的单个签名字段：**只有布尔**，没有一处能塞进上游写的自由文本 */
const PUBLIC_SIGNATURE_FLAGS = [
  'intact',
  'valid',
  'trusted',
  'coverage_ok',
  'signer_anchored_to_cfca',
  'timestamp_present',
  'timestamp_intact',
  'timestamp_trusted',
  'docmdp_ok',
  'bottom_line',
  'signature_ok',
] as const;

export type PublicSignature = Record<(typeof PUBLIC_SIGNATURE_FLAGS)[number], boolean | null>;

/** 允许离开服务器的裁决字段。新增字段必须在这里显式点名，默认一律留在服务端。 */
export interface PublicVerdict {
  file_sha256: string | null;
  expect_hash: string | null;
  hash_match: boolean | null;
  num_signatures: number;
  overall_ok: boolean;
  signatures: PublicSignature[];
}

/** 上游给的不是布尔就当「没结论」，绝不强转（'false' 转出来是 true，那是在编结论） */
function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 只认 64 位十六进制；别的一律当没有——哈希位上塞的任何自由文本都到此为止 */
function hex64(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value : null;
}

function publicSignature(row: unknown): PublicSignature {
  const src = (row !== null && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  return Object.fromEntries(
    PUBLIC_SIGNATURE_FLAGS.map((key) => [key, flag(src[key])]),
  ) as PublicSignature;
}

/**
 * 出境前的白名单投影：**列进来的才出得去**。
 *
 * 为什么不是「删掉 error 就行」：本端点公开无鉴权，而裁决体是 sidecar 写的——
 * 它今天在 error 里拼路径，明天可能在别的字段里拼。黑名单要追着上游改，
 * 白名单不用：新字段默认留在服务端，要出境得有人在这里写下它的名字。
 * 排障要看的完整裁决在服务端日志与 report.verdict 里，那条路没被动过。
 */
export function toPublicVerdict(verdict: VerifyVerdict | null): PublicVerdict | null {
  if (verdict === null) return null;
  return {
    file_sha256: hex64(verdict.file_sha256),
    expect_hash: hex64(verdict.expect_hash),
    hash_match: flag(verdict.hash_match),
    num_signatures: typeof verdict.num_signatures === 'number' && Number.isFinite(verdict.num_signatures)
      ? verdict.num_signatures
      : 0,
    overall_ok: verdict.overall_ok === true,
    signatures: Array.isArray(verdict.signatures) ? verdict.signatures.map(publicSignature) : [],
  };
}

/**
 * 实时复核一个存证订单。**公开无鉴权**，故带 IP 限流。
 *
 * @param ip 调用方 IP（路由层用 extractClientIp 取），限流按它计数
 */
export async function recheckVerification(
  db: Database,
  input: { orderNo: string; ip: string },
): Promise<Result<{ report: RecheckReport }>> {
  if (!recheckQuota.checkAndRecord(input.ip)) {
    return fail(429, 'RATE_LIMITED', '复核请求过于频繁，请稍后再试');
  }

  const orderNo = (input.orderNo ?? '').trim();
  if (!orderNo) return fail(404, 'ORDER_NOT_FOUND', '存证订单不存在');
  const att = store.findAttestationByOrderNo(db, orderNo);
  if (!att) return fail(404, 'ORDER_NOT_FOUND', '存证订单不存在');

  const hashCheck = checkHash(db, att);

  // 还没出证的订单不是"伪造"，是"没走完"——如实说明，但绝不判通过
  if (!att.cert_pdf_file_id) {
    const pending = '该订单尚未出具《存证证明》，无可验签的文件';
    return {
      ok: true,
      report: {
        order_no: att.order_no,
        overall_ok: false,
        checks: [hashCheck, item(CHECK_TST, false, pending), item(CHECK_SIGNATURE, false, pending)],
        verdict: null,
      },
    };
  }

  let pdf: Buffer;
  try {
    pdf = readBytes(db, att.cert_pdf_file_id);
  } catch (err) {
    const detail = toUserFacingError(err, {
      code: 'CERT_PDF_READ_FAILED',
      where: 'recheck.readCertPdf',
    }).message;
    return {
      ok: true,
      report: {
        order_no: att.order_no,
        overall_ok: false,
        checks: [hashCheck, item(CHECK_TST, false, detail), item(CHECK_SIGNATURE, false, detail)],
        verdict: null,
      },
    };
  }

  let verdict: VerifyVerdict;
  try {
    // passed 不用：本模块按分项自己下结论，overall_ok 由三项相与得出
    ({ verdict } = await verifyPdf(pdf));
  } catch (err) {
    // 「没验成」不是「验了不通过」——回错误，不回一个假的否定裁决
    return sidecarFailure(err);
  }

  // sidecar 自陈的失败原因在这里一次性过边界：原文（含服务器路径、异常内部态）进日志，
  // 往下传的只有文案。放在这里而不是 checkSignature 里，是为了「有原文就一定落日志」——
  // 不依赖「分项恰好判否时才会被调用」这个巧合。
  const errorTexts = verdictErrorTexts(verdict);
  const errorCopy =
    errorTexts.length === 0
      ? null
      : toUserFacingError(new Error(errorTexts.join(' ; ')), {
          code: 'SIGNATURE_VERDICT_ERROR',
          where: 'recheck.verdictError',
        }).message;

  const checks = [hashCheck, checkTimestamp(verdict, att), checkSignature(verdict, errorCopy)];
  return {
    ok: true,
    report: {
      order_no: att.order_no,
      // sidecar 自己的 overall_ok 也必须为真：它综合了 intact/valid/trusted/bottom_line，
      // 比我们逐项挑出来的三项更严，漏掉它等于放宽标准
      overall_ok: checks.every((c) => c.passed) && verdict.overall_ok === true,
      checks,
      verdict,
    },
  };
}
