// app/src/app/api/v1/verify/__tests__/recheck-route-leak.test.ts
// POST /api/v1/verify/:orderNo/recheck 的**出口过滤**。
//
// 这条端点公开无鉴权：拿到订单号的任何人（含仲裁对方）都能打，响应体直接渲染进
// /verify/{no} 公开页。所以这里钉死的不是"复核算得对不对"（那是 lib/evidence/recheck.test.ts
// 的活），而是**哪些字符串允许离开服务器**：
//   · 内部异常原文（服务器路径、file_id、上游端点）一个都不许进响应体；
//   · **sidecar 回 200 时裁决体里自带的错误文本**（verdict.error / signatures[].error，
//     裸 Python 异常原文）同样不许——它不走我方的 catch，得靠边界 + 白名单投影拦；
//   · 用户拿到的必须是三段式中文（缺什么 / 为什么缺 / 怎么办）；
//   · 原文必须**完整**留在服务端日志里——换壳不是消音，排障还得靠它。
// 同时复验「不吞结论」：换文案不许把 passed:false / overall_ok:false 变成别的。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { VerifyVerdict } from '@/lib/evidence';

type Handler = (req: Request, ctx: { params: Promise<{ orderNo: string }> }) => Promise<Response>;

let post: Handler;
let db: Database;
let evidence: typeof import('@/lib/evidence');
let dbEvidence: typeof import('@/lib/db/evidence');
let filesDir: string;

const IP = '203.0.113.9';
// 文件库按 SHA-256 全局去重：两个用例用同样的字节会共用同一份密文，
// 前一个用例删掉的盘上文件会把后一个用例的夹具一起弄坏。故每单的字节都掺进唯一串。
const ORIGINAL = () => Buffer.from(`这是一份解除劳动合同通知书的原件字节 ${crypto.randomUUID()}`);
const CERT_PDF = () => Buffer.from(`%PDF-1.7 假的存证证明 ${crypto.randomUUID()}`);

function request(orderNo: string): [Request, { params: Promise<{ orderNo: string }> }] {
  return [
    new Request(`http://localhost/api/v1/verify/${orderNo}/recheck`, {
      method: 'POST',
      headers: { 'x-real-ip': IP },
    }),
    { params: Promise.resolve({ orderNo }) },
  ];
}

/** sidecar /verify 的一份「全绿」裁决：本文件要验的是出口过滤，签名侧一律放行 */
function goodVerdict(): VerifyVerdict {
  return {
    file_sha256: 'whatever',
    expect_hash: null,
    hash_match: null,
    num_signatures: 1,
    signatures: [
      {
        field_name: 'Signature1',
        intact: true,
        valid: true,
        trusted: true,
        signature_ok: true,
        timestamp_present: true,
        timestamp_intact: true,
        timestamp_trusted: true,
      },
    ],
    overall_ok: true,
    error: null,
  };
}

function stubSidecar(status: number, body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

/** 接住 console.error，返回「本轮所有日志拼成的一整块文本」供断言 */
function captureServerLog(): () => string {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  return () => lines.join('\n');
}

/** 造一个「已出证」的完整订单，返回订单号与两份密文在盘上的绝对路径 */
function seedOrder(): { orderNo: string; originalEnc: string; certEnc: string } {
  const userId = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES (?, '已实名')")
      .run(`h-${crypto.randomUUID()}`).lastInsertRowid,
  );
  const caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '我的案件')").run(userId).lastInsertRowid,
  );

  const uploaded = evidence.uploadEvidence(db, {
    caseId,
    userId,
    bytes: ORIGINAL(),
    name: '解除通知',
    mime: 'application/pdf',
    category: '公司文件',
  });
  if (!uploaded.ok) throw new Error('夹具建证据失败');

  const orderNo = evidence.generateOrderNo();
  const attestationId = dbEvidence.insertAttestation(db, {
    evidenceId: uploaded.evidence.id,
    orderNo,
    sha256: uploaded.evidence.sha256,
    realnameSnapshotEnc: null,
    status: 'pending',
  });
  dbEvidence.fillAttestationTimestamp(db, {
    attestationId,
    tstB64: 'ZmFrZS10c3Q=',
    genTime: '2026-08-20T10:00:00Z',
    serial: '0x2a',
    tsaUrl: 'http://timestamp.globalsign.com/tsa/r6advanced1',
    status: 'stamped',
  });
  const certFile = evidence.storeBytes(db, CERT_PDF(), 'application/pdf');
  dbEvidence.fillAttestationCert(db, { attestationId, certPdfFileId: certFile.fileId, status: 'certified' });

  const detail = dbEvidence.findEvidenceDetail(db, uploaded.evidence.id)!;
  const encPathOf = (fileId: number) =>
    path.join(filesDir, dbEvidence.findFileById(db, fileId)!.enc_path);

  return {
    orderNo,
    originalEnc: encPathOf(detail.file_id),
    certEnc: encPathOf(certFile.fileId),
  };
}

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-recheck-route-${crypto.randomUUID()}.db`);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-recheck-route-files-'));
  process.env.FILES_DIR = filesDir;

  post = (await import('../[orderNo]/recheck/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
  evidence = await import('@/lib/evidence');
  dbEvidence = await import('@/lib/db/evidence');
});

beforeEach(() => {
  // FILES_DIR 在 beforeAll 之后可能被别的用例改过（files.ts 每次调用现读 env），钉回来
  process.env.FILES_DIR = filesDir;
  evidence.resetRecheckQuota();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('公开复核端点的出口过滤', () => {
  test('原件密文缺失：响应体不含 enc_path/file_id，给三段式文案，原文只在服务端日志里', async () => {
    const { orderNo, originalEnc } = seedOrder();
    fs.rmSync(originalEnc); // 库里有行、盘上没文件 —— readBytes 抛的正是那句带路径的错
    stubSidecar(200, goodVerdict());
    const serverLog = captureServerLog();

    const res = await post(...request(orderNo));
    const raw = await res.text();

    // ① 敏感串一个都不许过边界
    expect(raw).not.toContain('enc_path');
    expect(raw).not.toContain('file_id');
    expect(raw).not.toContain(path.basename(originalEnc));

    // ② 用户拿到的是三段式：出了什么事 / 为什么 / 怎么办
    const body = JSON.parse(raw) as { ok: boolean; overall_ok: boolean; checks: { name: string; passed: boolean; detail: string }[] };
    const hash = body.checks.find((c) => c.name === '哈希一致')!;
    expect(hash.detail).toContain('没能完成');
    expect(hash.detail).toContain('服务端读取原件时出错');
    expect(hash.detail).toContain('重新核验');

    // ③ 原文完整留在服务端日志（换壳不是消音）
    const log = serverLog();
    expect(log).toContain('enc_path');
    expect(log).toContain('EVIDENCE_READ_FAILED');
    expect(log).toContain('recheck.checkHash');

    // ④ 不吞结论：读不到原件仍然是「这一项没过」，不是被抹成通过
    expect(hash.passed).toBe(false);
    expect(body.overall_ok).toBe(false);
  });

  test('《存证证明》密文缺失：同样只出三段式，且不连坐哈希那一项的结论', async () => {
    const { orderNo, certEnc } = seedOrder();
    fs.rmSync(certEnc);
    stubSidecar(200, goodVerdict());
    const serverLog = captureServerLog();

    const res = await post(...request(orderNo));
    const raw = await res.text();

    expect(raw).not.toContain('enc_path');
    expect(raw).not.toContain(path.basename(certEnc));

    const body = JSON.parse(raw) as { overall_ok: boolean; checks: { name: string; passed: boolean; detail: string }[] };
    const tst = body.checks.find((c) => c.name === 'TST 有效')!;
    expect(tst.detail).toContain('服务端读取《存证证明》文件时出错');
    expect(tst.detail).toContain('重新核验');
    expect(tst.passed).toBe(false);
    // 哈希是独立算出来的，读不到证明 PDF 不该把它一起判死
    expect(body.checks.find((c) => c.name === '哈希一致')!.passed).toBe(true);
    expect(body.overall_ok).toBe(false);

    expect(serverLog()).toContain('CERT_PDF_READ_FAILED');
  });

  test.each([
    [503, 'RECHECK_UNAVAILABLE', '还没就绪'],
    [500, 'RECHECK_UPSTREAM_FAILED', '没有响应'],
  ])('sidecar %i：错误码照旧，但上游端点与 detail 不过边界', async (status, code, copy) => {
    const { orderNo } = seedOrder();
    // sidecar 自己的 detail 里可能带内部路径/证书位置，它同样不该出现在公开响应里
    stubSidecar(status, { detail: '签名证书未配置: /etc/lawer/sidecar/signing.p12' });
    const serverLog = captureServerLog();

    const res = await post(...request(orderNo));
    const raw = await res.text();

    expect(raw).not.toContain('/etc/lawer/sidecar');
    expect(raw).not.toContain('sidecar');
    expect(raw).not.toContain('HTTP');

    const body = JSON.parse(raw) as { ok: boolean; error_code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe(code);
    expect(body.message).toContain(copy);
    // 「没验成」不是「没通过」——这句话必须还在
    expect(body.message).toMatch(/不是这份材料有问题|不是核验没通过/);

    const log = serverLog();
    expect(log).toContain('/etc/lawer/sidecar');
    expect(log).toContain(code);
  });
});

/* ── sidecar 回 200 裁决时的另一半：脏值在响应体里，不在异常里 ───────── */

// sidecar/verify_evidence_pdf.py 的五处投毒点都长这样：`f"...: {e}"` 直接拼异常对象，
// 于是服务器绝对路径与 ValueError 内部态原样落进裁决 JSON。它不经我方任何 catch。
const PY_TOP_ERROR =
  '无法解析 PDF 或其签名: ValueError: xref table damaged at /opt/lawer/sidecar/verify_evidence_pdf.py:151';
const PY_ROW_ERROR =
  '验签异常: ValueError: 无法读取信任锚 /opt/lawer/sidecar/trust_anchors/cfca-identity-ca.pem';

const SHA = crypto.createHash('sha256').update('cert-pdf').digest('hex');

/** 白名单：只有这些字段允许离开服务器（顺序无关，逐字比对） */
const PUBLIC_VERDICT_KEYS = [
  'expect_hash',
  'file_sha256',
  'hash_match',
  'num_signatures',
  'overall_ok',
  'signatures',
];
const PUBLIC_SIGNATURE_KEYS = [
  'bottom_line',
  'coverage_ok',
  'docmdp_ok',
  'intact',
  'signature_ok',
  'signer_anchored_to_cfca',
  'timestamp_intact',
  'timestamp_present',
  'timestamp_trusted',
  'trusted',
  'valid',
];

function assertNoPythonLeak(raw: string): void {
  expect(raw).not.toContain('/opt/lawer');
  expect(raw).not.toContain('ValueError');
  expect(raw).not.toContain('verify_evidence_pdf');
  expect(raw).not.toContain('trust_anchors');
}

describe('sidecar 裁决体里的裸 Python 异常', () => {
  test('顶层 verdict.error：不进 detail、不随裁决出境，原文只在服务端日志里', async () => {
    const { orderNo } = seedOrder();
    // 「PDF 解析不了」那一类：sidecar 早退，signatures 空，理由全在顶层 error
    stubSidecar(200, {
      ...goodVerdict(),
      file_sha256: SHA,
      num_signatures: 0,
      signatures: [],
      overall_ok: false,
      error: PY_TOP_ERROR,
    });
    const serverLog = captureServerLog();

    const res = await post(...request(orderNo));
    const raw = await res.text();

    assertNoPythonLeak(raw);
    expect(raw).not.toContain(PY_TOP_ERROR);

    const body = JSON.parse(raw) as {
      overall_ok: boolean;
      checks: { name: string; passed: boolean; detail: string }[];
      verdict: Record<string, unknown>;
    };
    // ① 用户拿到的是三段式：出了什么事 / 为什么 / 怎么办
    const sig = body.checks.find((c) => c.name === '签名有效')!;
    expect(sig.detail).toContain('数字签名未通过校验');
    expect(sig.detail).toContain('内部诊断信息');
    expect(sig.detail).toContain('重新核验');
    // ② 不吞结论：验签没过仍然是没过
    expect(sig.passed).toBe(false);
    expect(body.overall_ok).toBe(false);
    // ③ 裁决按白名单出境，error 这一格根本不存在
    expect(Object.keys(body.verdict).sort()).toEqual(PUBLIC_VERDICT_KEYS);
    expect(body.verdict).not.toHaveProperty('error');
    // ④ 原文完整留在服务端日志（换壳不是消音）
    const log = serverLog();
    expect(log).toContain(PY_TOP_ERROR);
    expect(log).toContain('SIGNATURE_VERDICT_ERROR');
    expect(log).toContain('recheck.verdictError');
  });

  test('签名行 signatures[].error：同样过不了边界，原文照样落日志', async () => {
    const { orderNo } = seedOrder();
    const base = goodVerdict();
    stubSidecar(200, {
      ...base,
      file_sha256: SHA,
      error: null, // 顶层干净，脏的只有行内——这一半此前是靠 verdict 全量透传漏出去的
      signatures: [{ ...(base.signatures[0] as Record<string, unknown>), signature_ok: false, error: PY_ROW_ERROR }],
      overall_ok: false,
    });
    const serverLog = captureServerLog();

    const res = await post(...request(orderNo));
    const raw = await res.text();

    assertNoPythonLeak(raw);
    expect(raw).not.toContain(PY_ROW_ERROR);

    const body = JSON.parse(raw) as {
      overall_ok: boolean;
      checks: { name: string; passed: boolean; detail: string }[];
      verdict: { signatures: Record<string, unknown>[] };
    };
    const sig = body.checks.find((c) => c.name === '签名有效')!;
    expect(sig.detail).toContain('内部诊断信息');
    expect(sig.passed).toBe(false);
    expect(body.overall_ok).toBe(false);
    // 哈希是独立算出来的，签名侧报错不该把它连坐
    expect(body.checks.find((c) => c.name === '哈希一致')!.passed).toBe(true);

    expect(Object.keys(body.verdict.signatures[0]).sort()).toEqual(PUBLIC_SIGNATURE_KEYS);
    expect(body.verdict.signatures[0]).not.toHaveProperty('error');

    const log = serverLog();
    expect(log).toContain(PY_ROW_ERROR);
    expect(log).toContain('SIGNATURE_VERDICT_ERROR');
  });

  test('白名单投影：上游新塞的字段默认留在服务端，点了名的布尔与哈希照旧出境', async () => {
    const { orderNo } = seedOrder();
    const base = goodVerdict();
    // 「sidecar 明天在别的字段里拼路径」——黑名单追不上，白名单不用追
    stubSidecar(200, {
      ...base,
      file_sha256: SHA,
      debug_dump: '/opt/lawer/sidecar/state.json',
      signatures: [
        {
          ...(base.signatures[0] as Record<string, unknown>),
          signer_cn: '某某科技有限公司',
          coverage: 'AreaCoverage.ENTIRE_REVISION',
          raw_trace: 'Traceback (most recent call last): /opt/lawer/sidecar/main.py',
        },
      ],
    });

    const res = await post(...request(orderNo));
    const raw = await res.text();

    assertNoPythonLeak(raw);
    expect(raw).not.toContain('debug_dump');
    expect(raw).not.toContain('signer_cn');

    const body = JSON.parse(raw) as {
      overall_ok: boolean;
      verdict: { file_sha256: string; num_signatures: number; signatures: Record<string, unknown>[] };
    };
    expect(Object.keys(body.verdict).sort()).toEqual(PUBLIC_VERDICT_KEYS);
    expect(Object.keys(body.verdict.signatures[0]).sort()).toEqual(PUBLIC_SIGNATURE_KEYS);
    // 投影不是「一律清空」：该出去的照旧出得去，否则这条端点就白公开了
    expect(body.verdict.file_sha256).toBe(SHA);
    expect(body.verdict.num_signatures).toBe(1);
    expect(body.verdict.signatures[0].signature_ok).toBe(true);
    expect(body.verdict.signatures[0].timestamp_trusted).toBe(true);
    expect(body.overall_ok).toBe(true);
  });
});
