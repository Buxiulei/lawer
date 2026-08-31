// app/src/lib/evidence/__tests__/recheck.test.ts
// 存证订单实时复核。sidecar 全程 mock（打 fetch），可离线跑。
//
// 这里钉死的核心区分：sidecar「验了但不通过」→ 返回裁决（各项 passed=false）；
// sidecar「没验成」（服务挂了）→ 返回 502/503 错误，**绝不**伪装成一个否定裁决——
// 在公开验证页上把服务故障说成"证据无效"，等于诬告用户的证据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密调用之前就位（crypto 首次调用时读 env 并缓存）
process.env.LAWER_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

import * as dbEvidence from '@/lib/db/evidence';
import { runMigrations } from '@/lib/db/migrate';
import * as evidence from '@/lib/evidence';
import type { VerifyVerdict } from '@/lib/evidence';

const IP = '203.0.113.7';
const ORIGINAL = Buffer.from('这是一份解除劳动合同通知书的原件字节');
const CERT_PDF = Buffer.from('%PDF-1.7 假的存证证明');

interface Fixture {
  db: Database;
  tmpDir: string;
  orderNo: string;
  attestationId: number;
  evidenceId: number;
}

let fx: Fixture;

/** 造一个「已出证」的完整订单：原件 + 时间戳 + 已签名的证明 PDF */
function makeFixture(): Fixture {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-recheck-'));
  process.env.FILES_DIR = tmpDir;

  const userId = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run()
      .lastInsertRowid,
  );
  const caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '我的案件')").run(userId)
      .lastInsertRowid,
  );

  const uploaded = evidence.uploadEvidence(db, {
    caseId,
    userId,
    bytes: ORIGINAL,
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
  const certFile = evidence.storeBytes(db, CERT_PDF, 'application/pdf');
  dbEvidence.fillAttestationCert(db, {
    attestationId,
    certPdfFileId: certFile.fileId,
    status: 'certified',
  });

  return { db, tmpDir, orderNo, attestationId, evidenceId: uploaded.evidence.id };
}

/** sidecar /verify 的一份「全绿」裁决 */
function goodVerdict(overrides: Partial<VerifyVerdict> = {}): VerifyVerdict {
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
    ...overrides,
  };
}

/** 假 sidecar：/verify 一律 HTTP 200 + 给定裁决（"验了但不通过"也是 200，这是契约） */
function stubSidecar(verdict: VerifyVerdict) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(verdict), { status: 200 }),
  );
}

/** 假 sidecar：整个服务坏了，非 2xx */
function stubSidecarDown(status: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify({ detail: '签名证书未配置' }), { status }),
  );
}

function checkOf(report: evidence.RecheckReport, name: string): evidence.RecheckItem {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`没有名为 ${name} 的分项`);
  return found;
}

beforeEach(() => {
  fx = makeFixture();
  evidence.resetRecheckQuota();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fx.tmpDir, { recursive: true, force: true });
});

describe('recheckVerification', () => {
  test('复核通过：三项全绿，overall_ok=true', async () => {
    stubSidecar(goodVerdict());

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.overall_ok).toBe(true);
    expect(result.report.order_no).toBe(fx.orderNo);
    expect(result.report.checks.map((c) => c.name)).toEqual(['哈希一致', 'TST 有效', '签名有效']);
    for (const check of result.report.checks) {
      expect(check.passed).toBe(true);
      expect(check.detail).toBeTruthy();
    }
  });

  test('哈希不符：原件被换掉后复算对不上，overall_ok=false 且指出实得哈希', async () => {
    stubSidecar(goodVerdict());
    // 把存证记录里的哈希改掉，等价于「盘上这份原件不是当初存证的那份」
    fx.db
      .prepare('UPDATE attestations SET sha256 = ? WHERE id = ?')
      .run('0'.repeat(64), fx.attestationId);

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.overall_ok).toBe(false);
    const hash = checkOf(result.report, '哈希一致');
    expect(hash.passed).toBe(false);
    expect(hash.detail).toContain('不符');
    // 签名那两项与哈希无关，不该被连坐
    expect(checkOf(result.report, '签名有效').passed).toBe(true);
  });

  test('原件文件在盘上丢了：算作原件不可信，不是服务故障', async () => {
    stubSidecar(goodVerdict());
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    fs.mkdirSync(fx.tmpDir, { recursive: true });

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.overall_ok).toBe(false);
    expect(checkOf(result.report, '哈希一致').passed).toBe(false);
  });

  test('sidecar 验了但不通过（HTTP 200 + overall_ok=false）→ 如实回否定裁决', async () => {
    stubSidecar(
      goodVerdict({
        overall_ok: false,
        // sidecar 自陈的原因是它自己拼的裸 Python 异常原文（含服务器路径），
        // 出去的只能是净化后的文案；结论仍旧是「这一项没过」
        error: '验签异常: ValueError: 覆盖范围不足 /opt/lawer/sidecar/verify_evidence_pdf.py',
        signatures: [
          {
            field_name: 'Signature1',
            intact: false,
            valid: true,
            trusted: false,
            signature_ok: false,
            timestamp_present: true,
            timestamp_intact: true,
            timestamp_trusted: true,
          },
        ],
      }),
    );

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.overall_ok).toBe(false);
    expect(checkOf(result.report, '签名有效').passed).toBe(false);
    const detail = checkOf(result.report, '签名有效').detail;
    expect(detail).toContain('数字签名未通过校验');
    expect(detail).not.toContain('/opt/lawer');
    expect(detail).not.toContain('ValueError');
  });

  test('sidecar 只把 overall_ok 判否、分项却全绿时，仍然不判通过', async () => {
    // 防「只看分项、漏读 overall_ok」——它综合了 bottom_line/差异分析，比分项更严
    stubSidecar(goodVerdict({ overall_ok: false }));

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.overall_ok).toBe(false);
  });

  test('未签名件（num_signatures=0）绝不判通过', async () => {
    stubSidecar(goodVerdict({ num_signatures: 0, signatures: [], overall_ok: false }));

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checkOf(result.report, 'TST 有效').passed).toBe(false);
    expect(checkOf(result.report, '签名有效').passed).toBe(false);
  });

  test('sidecar 报坏（503 依赖未配置）→ 回 RECHECK_UNAVAILABLE，不是 passed:false', async () => {
    stubSidecarDown(503);

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result).toMatchObject({ ok: false, status: 503, errorCode: 'RECHECK_UNAVAILABLE' });
  });

  test('sidecar 报坏（502 上游失败）→ 回 RECHECK_UPSTREAM_FAILED', async () => {
    stubSidecarDown(502);

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result).toMatchObject({ ok: false, status: 502, errorCode: 'RECHECK_UPSTREAM_FAILED' });
  });

  test('订单尚未出证：如实说明，绝不判通过，也不去打 sidecar', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    fx.db
      .prepare("UPDATE attestations SET cert_pdf_file_id = NULL, status = 'stamped' WHERE id = ?")
      .run(fx.attestationId);

    const result = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.overall_ok).toBe(false);
    expect(result.report.verdict).toBeNull();
    expect(checkOf(result.report, '签名有效').detail).toContain('尚未出具');
    // 原件哈希这一项照样能核
    expect(checkOf(result.report, '哈希一致').passed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test('订单不存在 → 404，与「存在但没出证」区分开', async () => {
    const result = await evidence.recheckVerification(fx.db, { orderNo: 'LAWER-ATT-无此单', ip: IP });
    expect(result).toMatchObject({ ok: false, status: 404, errorCode: 'ORDER_NOT_FOUND' });
  });
});

describe('公开端点限流', () => {
  test('同一 IP 24h 内 30 次封顶，第 31 次回 429', async () => {
    stubSidecar(goodVerdict());

    for (let i = 0; i < 30; i += 1) {
      const ok = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
      expect(ok.ok).toBe(true);
    }
    const denied = await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    expect(denied).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
  });

  test('额度按 IP 各记各的，一个 IP 打满不影响别人', async () => {
    stubSidecar(goodVerdict());

    for (let i = 0; i < 30; i += 1) {
      await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP });
    }
    expect(await evidence.recheckVerification(fx.db, { orderNo: fx.orderNo, ip: IP })).toMatchObject(
      { ok: false, errorCode: 'RATE_LIMITED' },
    );
    const other = await evidence.recheckVerification(fx.db, {
      orderNo: fx.orderNo,
      ip: '198.51.100.9',
    });
    expect(other.ok).toBe(true);
  });

  test('订单不存在也照样扣额度，免得拿它当免费探测口', async () => {
    for (let i = 0; i < 30; i += 1) {
      await evidence.recheckVerification(fx.db, { orderNo: '无此单', ip: IP });
    }
    const denied = await evidence.recheckVerification(fx.db, { orderNo: '无此单', ip: IP });
    expect(denied).toMatchObject({ ok: false, status: 429 });
  });
});
