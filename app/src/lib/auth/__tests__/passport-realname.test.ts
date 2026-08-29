// app/src/lib/auth/__tests__/passport-realname.test.ts
// 护照实名通道。
//
// 【判据的重点】不是"能建一条流水"，是三件会真出事的：
//  ① 待审期间 attest 必须仍然拿不到（manager 要的负向样本）；
//  ② 护照号不得以明文出现在库里任何一列；
//  ③ 待审的护照流水查 status 不得 500——那是我这套设计差点引入的 bug：
//     cert_no 按隐私设计恒为 null，而 cloudauth 那条路把 null 当"流水损坏"。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import { decryptField } from '@/lib/crypto';
import { requireRealname } from '../guard';
import {
  approvePassportRealname,
  initPassportRealname,
  planPassportApproval,
} from '../passport-realname';
import { AUTH_STATUS, VERIFICATION_STATUS, refreshRealnameStatus } from '../realname';
import { makeTestDb } from './helpers';

const PASSPORT = 'E12345678';
const NAME = '张三';
let db: Database;
let uid: number;

const png = (tag: string) => Buffer.from(`fake-png-${tag}-${'x'.repeat(64)}`);

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  db = makeTestDb();
  uid = Number(
    db.prepare("INSERT INTO users (email) VALUES ('p@t.com')").run().lastInsertRowid,
  );
});

function init(over: Record<string, unknown> = {}) {
  return initPassportRealname(db, {
    userId: uid,
    realName: NAME,
    passportNo: PASSPORT,
    idPage: { bytes: png('idpage'), mime: 'image/png' },
    selfie: { bytes: png('selfie'), mime: 'image/png' },
    ...over,
  });
}

describe('发起', () => {
  test('落一条待审流水，users 转「待审」', () => {
    const r = init();
    expect(r.ok).toBe(true);
    const row = db.prepare('SELECT * FROM realname_verifications WHERE user_id=?').get(uid) as {
      provider: string; status: string; cert_no: string | null;
    };
    expect(row.provider).toBe('passport');
    expect(row.status).toBe(VERIFICATION_STATUS.pending);
    const u = db.prepare('SELECT auth_status FROM users WHERE id=?').get(uid) as { auth_status: string };
    expect(u.auth_status).toBe(AUTH_STATUS.pending);
  });

  test('两件材料都落了盘，且各自有哈希', () => {
    const r = init();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = planPassportApproval(db, r.verificationId);
    expect(plan.materials.id_page.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.materials.selfie.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.materials.id_page.sha256).not.toBe(plan.materials.selfie.sha256);
    expect((db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(2);
  });

  test('🔴 护照号不得以明文出现在库里任何一列', () => {
    init();
    // 【为什么全表扫】只断言 cert_no 为空是不够的——PII 泄漏不挑列。
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v === 'string') {
            expect(v, `${t}.${col} 里出现了明文护照号`).not.toContain(PASSPORT);
          }
        }
      }
    }
  });

  test('校验：姓名空 / 护照号非法 / 材料缺失，各自给出可分辨的错误码', () => {
    expect(init({ realName: '  ' })).toMatchObject({ errorCode: 'INVALID_NAME' });
    expect(init({ passportNo: 'E!2345' })).toMatchObject({ errorCode: 'INVALID_PASSPORT_NO' });
    expect(init({ selfie: { bytes: Buffer.alloc(0), mime: null } })).toMatchObject({
      errorCode: 'MISSING_MATERIAL',
    });
  });

  test('已实名的人不许重走', () => {
    db.prepare("UPDATE users SET auth_status=? WHERE id=?").run(AUTH_STATUS.verified, uid);
    expect(init()).toMatchObject({ status: 409, errorCode: 'ALREADY_VERIFIED' });
  });
});

describe('🔴 ④ 待审不得解锁 attest（manager 要的负向样本）', () => {
  test('提交材料之后、审核之前，requireRealname 仍然拒绝', () => {
    init();
    const gate = requireRealname(db, { uid, via: 'web' } as never);
    expect(gate.ok).toBe(false);
  });

  test('审核通过之后才放行', () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    approvePassportRealname(db, { verificationId: r.verificationId, operator: '审核员甲' });
    expect(requireRealname(db, { uid, via: 'web' } as never).ok).toBe(true);
  });
});

describe('审核落定', () => {
  test('users 回填姓名/护照号/cert_type，流水转「已实名」', () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    approvePassportRealname(db, { verificationId: r.verificationId, operator: '审核员甲' });

    const u = db.prepare('SELECT auth_status, cert_type, real_name_enc, id_card_enc FROM users WHERE id=?').get(uid) as Record<string, string | null>;
    expect(u.auth_status).toBe(AUTH_STATUS.verified);
    expect(u.cert_type).toBe('护照');
    expect(u.real_name_enc).toBeTruthy();
    expect(u.id_card_enc).toBeTruthy();
    // 密文，不是明文
    expect(u.id_card_enc).not.toContain(PASSPORT);

    const row = db.prepare('SELECT status FROM realname_verifications WHERE id=?').get(r.verificationId) as { status: string };
    expect(row.status).toBe(VERIFICATION_STATUS.passed);
  });

  test('留痕带审核人、时刻与两份材料哈希', () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    const plan = approvePassportRealname(db, {
      verificationId: r.verificationId,
      operator: '审核员甲',
      note: '姓名与护照号逐字核对一致',
    });
    const enc = (db.prepare('SELECT raw_meta_enc FROM realname_verifications WHERE id=?').get(r.verificationId) as { raw_meta_enc: string }).raw_meta_enc;
    // 解密走产线自己的函数，不另抄一份
    const env = JSON.parse(decryptField(enc));
    expect(env.audit.operator).toBe('审核员甲');
    expect(env.audit.note).toBe('姓名与护照号逐字核对一致');
    expect(env.audit.material_sha256).toEqual([
      plan.materials.id_page.sha256,
      plan.materials.selfie.sha256,
    ]);
    expect(typeof env.audit.approved_at).toBe('string');
  });

  test('不记名不许落定——留痕没有「谁」就不成其为留痕', () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    expect(() =>
      approvePassportRealname(db, { verificationId: r.verificationId, operator: '   ' }),
    ).toThrow(/必须记名/);
  });

  test('同一条不许审两次', () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    approvePassportRealname(db, { verificationId: r.verificationId, operator: '甲' });
    expect(() =>
      approvePassportRealname(db, { verificationId: r.verificationId, operator: '乙' }),
    ).toThrow(/已落定/);
  });

  test('不是护照通道的流水，本函数拒绝处理', () => {
    const vid = Number(
      db.prepare("INSERT INTO realname_verifications (user_id, provider, status) VALUES (?, 'cloudauth', ?)").run(uid, VERIFICATION_STATUS.pending).lastInsertRowid,
    );
    expect(() => planPassportApproval(db, vid)).toThrow(/不是护照通道/);
  });
});

describe('🔴 status 不得对待审护照报 500（差点引入的 bug）', () => {
  test('待审护照查状态：正常返回、method=passport、不碰阿里云', async () => {
    init();
    const res = await refreshRealnameStatus(db, { userId: uid });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 【为什么这条是回归】cert_no 按隐私设计恒为 null，而 cloudauth 那条路
    // 把 null 当「流水损坏」直接 500 —— 不岔开的话，每个待审护照用户查一次状态拿一个 500。
    expect(res.verificationStatus).toBe(VERIFICATION_STATUS.pending);
    expect(res.method).toBe('passport');
    expect(res.authStatus).toBe(AUTH_STATUS.pending);
  });

  test('落定后 status 形状不变，只是值变了', async () => {
    const r = init();
    if (!r.ok) throw new Error('前置失败');
    approvePassportRealname(db, { verificationId: r.verificationId, operator: '甲' });
    const res = await refreshRealnameStatus(db, { userId: uid });
    expect(res).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.verified,
      verificationStatus: VERIFICATION_STATUS.passed,
      method: 'passport',
    });
  });
});
