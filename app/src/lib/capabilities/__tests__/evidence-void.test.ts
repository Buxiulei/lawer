// app/src/lib/capabilities/__tests__/evidence-void.test.ts
// evidence_void（作废）：作废之后它必须从**每一个把材料当证据用**的视图里消失。
//
// 判据不是「有一个 void_reason 列」——那是实现。判据是四条出口各自的行为：
//   ① evidence_list 默认不回它（include_voided 才回）
//   ② 事实卡（case-facts）不列它、分类计数也不含它
//   ③ evidence_attest 拒绝它，且**一行 attestations 都不留**
//   ④ 已出证的作废不撤销订单：attestations 那一行原样还在，attest_verify 照旧查得到
// 变异臂：把 listEvidence 的过滤去掉 ⇒ ①②当场红。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { encryptField } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import * as evidence from '@/lib/evidence';
import { buildCaseFacts } from '@/lib/agent/case-facts';
import { loadCaseSnapshot } from '@/lib/agent/snapshot';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db: Database;
let uid: number;
let caseId: number;
let tmpDir: string;

const FAKE_TST = 'MIILAQYJKoZIhvcNAQcCoIIK8jCCCu4CAQMx';

function mockSidecarOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/signer')) {
        return new Response(
          JSON.stringify({ signer_cn: '某某公司', signer_org: null, not_before: null, not_after: null, serial: 'x' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/tsa')) {
        return new Response(
          JSON.stringify({
            tst_b64: FAKE_TST,
            gen_time: '2026-09-05T03:42:58+00:00',
            serial: '1282279059327074844',
            tsa_url: 'http://tsa.example/tsa',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/evidence-pdf')) return new Response(new Uint8Array(Buffer.from('%PDF unsigned')), { status: 200 });
      if (u.endsWith('/pades')) return new Response(new Uint8Array(Buffer.from('%PDF signed')), { status: 200 });
      throw new Error(`未预期的 sidecar 调用: ${u}`);
    }),
  );
}

function identity(): Identity {
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

async function call(name: string, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`没有这个能力：${name}`);
  return (await cap.run(db, identity(), args)) as Record<string, unknown>;
}

function makeEvidence(name: string) {
  const r = evidence.uploadEvidence(db, {
    caseId,
    userId: uid,
    bytes: Buffer.from(name),
    name,
    mime: 'image/jpeg',
    category: '公司文件',
    provePurpose: '证明公司单方解除',
    originalMedium: '手机拍照',
  });
  if (!r.ok) throw new Error(`造样本失败：${r.errorCode}`);
  return r.evidence.id;
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db
      .prepare(
        `INSERT INTO users (phone_hash, real_name_enc, id_card_enc, auth_status, cert_type)
         VALUES ('h-a', ?, ?, '已实名', '身份证')`,
      )
      .run(encryptField('张三'), encryptField('110101199001011234')).lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '甲的案子', '风声')").run(uid).lastInsertRowid,
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-void-'));
  process.env.FILES_DIR = tmpDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

describe('作废后各视图不见', () => {
  test('evidence_list 默认不回作废条目，include_voided=true 才回', async () => {
    const keep = makeEvidence('留着的.jpg');
    const drop = makeEvidence('重复上传的.jpg');

    await call('evidence_void', { evidence_id: drop, reason: '与「留着的.jpg」是同一份' });

    const listed = (await call('evidence_list', { case_id: caseId })).evidence as { id: number }[];
    expect(listed.map((e) => e.id)).toEqual([keep]);

    const all = (await call('evidence_list', { case_id: caseId, include_voided: true }))
      .evidence as { id: number; status: string }[];
    expect(all.map((e) => e.id).sort()).toEqual([keep, drop].sort());
    expect(all.find((e) => e.id === drop)!.status).toBe('已作废');
  });

  test('事实卡不含作废条目：明细不出现它的名字，分类计数也少一件', async () => {
    makeEvidence('留着的.jpg');
    const drop = makeEvidence('拿错版本的.jpg');

    const before = buildCaseFacts(loadCaseSnapshot(db, caseId)).sections.find((s) => s.key === 'evidence')!;
    expect(before.stat).toContain('证据共 2 条');

    await call('evidence_void', { evidence_id: drop, reason: '拿错版本' });

    const after = buildCaseFacts(loadCaseSnapshot(db, caseId)).sections.find((s) => s.key === 'evidence')!;
    expect(after.stat).toContain('证据共 1 条');
    expect(after.stat).toContain('公司文件 1');
    expect(after.detail.join('\n')).not.toContain('拿错版本的.jpg');
  });

  test('作废的不能出证，且一行存证订单都不留', async () => {
    mockSidecarOk();
    const id = makeEvidence('草稿版.jpg');
    await call('evidence_void', { evidence_id: id, reason: '当事人确认这是草稿版' });

    const res = await call('evidence_attest', { evidence_ids: [id] });
    const results = res.results as { ok: boolean; error_code: string }[];
    expect(results[0].ok).toBe(false);
    expect(results[0].error_code).toBe('EVIDENCE_VOIDED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 0 });
  });
});

describe('已出证的作废只标记，不撤销订单', () => {
  test('订单行原样还在，attest_verify 照旧查得到', async () => {
    mockSidecarOk();
    const id = makeEvidence('解除通知.jpg');
    const attested = await call('evidence_attest', { evidence_ids: [id] });
    const orderNo = (attested.results as { order_no: string }[])[0].order_no;

    const voided = await call('evidence_void', { evidence_id: id, reason: '当事人改用另一份原件' });
    expect(voided.ok).toBe(true);
    expect(voided.attested).toBe(true);
    expect(voided.previous_status).toBe('已出证');

    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE order_no = ?').get(orderNo)).toEqual({ n: 1 });
    const verified = await call('attest_verify', { order_no: orderNo });
    expect(verified.ok).toBe(true);
  });
});

describe('入参与幂等', () => {
  test('reason 为空一律拒，且什么都不改', async () => {
    const id = makeEvidence('某份.jpg');
    const res = await call('evidence_void', { evidence_id: id, reason: '   ' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('VOID_REASON_REQUIRED');
    expect(db.prepare('SELECT voided_at FROM evidence WHERE id = ?').get(id)).toEqual({ voided_at: null });
  });

  test('别人的 evidence_id 一律 404，且零写入', async () => {
    const other = Number(
      db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h-b', '未认证')").run().lastInsertRowid,
    );
    const otherCase = Number(
      db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '乙的案子', '风声')").run(other).lastInsertRowid,
    );
    const r = evidence.uploadEvidence(db, {
      caseId: otherCase,
      userId: other,
      bytes: Buffer.from('乙的材料'),
      name: '乙的材料.jpg',
      mime: 'image/jpeg',
      category: '公司文件',
    });
    if (!r.ok) throw new Error('造样本失败');

    const res = await call('evidence_void', { evidence_id: r.evidence.id, reason: '试试' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('EVIDENCE_NOT_FOUND');
    expect(db.prepare('SELECT voided_at FROM evidence WHERE id = ?').get(r.evidence.id)).toEqual({ voided_at: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_writes').get()).toEqual({ n: 0 });
  });

  test('作废两次不改写首次的理由与时刻，并落一行 agent_writes', async () => {
    const id = makeEvidence('某份.jpg');
    const first = await call('evidence_void', { evidence_id: id, reason: '第一次的理由' });
    const again = await call('evidence_void', { evidence_id: id, reason: '第二次换个说法' });
    expect(again.void_reason).toBe('第一次的理由');
    expect(again.voided_at).toBe(first.voided_at);

    const writes = db
      .prepare("SELECT COUNT(*) AS n FROM agent_writes WHERE tool = 'evidence_void'")
      .get() as { n: number };
    expect(writes.n).toBeGreaterThanOrEqual(1);
  });
});
