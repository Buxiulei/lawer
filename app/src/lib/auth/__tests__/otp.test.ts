// app/src/lib/auth/__tests__/otp.test.ts
// 限流是这个模块唯一挡住「短信被刷爆 / 验证码被爆破」的东西，四条规则各一例，一条都不能松。
// 全程 mock 短信与邮件发送：真发既费钱又会打扰真实号码。
import { beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';

import { hashLookup } from '@/lib/crypto';
import type { MailCopy } from '@/lib/notify';
import { resetIpQuota } from '../ip-quota';
import { sendEmailCode, sendPhoneCode, verifyEmailCode, verifyPhoneCode } from '../otp';
import { verifyToken } from '../jwt';
import { lastEmailCode, lastSmsCode, makeTestDb } from './helpers';

const PHONE = '13800138000';
const IP = '203.0.113.7';
const T0 = new Date('2026-08-19T10:00:00.000Z');

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

/** 假短信/邮件通道，记录每次发出的验证码 */
function makeDeps(now: Date) {
  const sms = vi.fn(async (_phone: string, _code: string) => {});
  const email = vi.fn(async (_to: string, _copy: MailCopy) => {});
  return { deps: { sendSms: sms, sendEmail: email, now }, sms, email };
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  delete process.env.SMS_CODE_EXPIRY_MINUTES;
  resetIpQuota();
});

describe('发码限流', () => {
  test('同一手机号 60s 内只能再发一次，重发返回 retry_after: 60', async () => {
    const db = makeTestDb();
    const first = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    expect(first.ok).toBe(true);

    const second = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(59)).deps);
    expect(second).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });

    // 满 60s 后放行
    const third = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(61)).deps);
    expect(third.ok).toBe(true);
  });

  test('同一手机号 24h 内最多 10 次', async () => {
    const db = makeTestDb();
    for (let i = 0; i < 10; i++) {
      const result = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(i * 120)).deps);
      expect(result.ok).toBe(true);
    }
    const eleventh = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(10 * 120)).deps);
    expect(eleventh).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
    // 日上限没有"再等 60 秒"这一说，不给 retry_after
    expect((eleventh as { retryAfter?: number }).retryAfter).toBeUndefined();
  });

  test('同一 IP 24h 内最多 30 次（换手机号也挡）', async () => {
    const db = makeTestDb();
    for (let i = 0; i < 30; i++) {
      const phone = `1380013${String(8000 + i).padStart(4, '0')}`;
      const result = await sendPhoneCode(db, { phone, ip: IP }, makeDeps(T0).deps);
      expect(result.ok).toBe(true);
    }
    const blocked = await sendPhoneCode(db, { phone: '13900139000', ip: IP }, makeDeps(T0).deps);
    expect(blocked).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });

    // 换 IP 不受影响，说明确实是按 IP 分桶而不是全局桶
    const other = await sendPhoneCode(db, { phone: '13900139000', ip: '198.51.100.2' }, makeDeps(T0).deps);
    expect(other.ok).toBe(true);
  });

  test('短信上游报流控时映射成 SMS_RATE_LIMITED 而不是 500', async () => {
    const db = makeTestDb();
    const deps = {
      now: T0,
      sendSms: vi.fn(async () => {
        throw new Error('触发天级流控 Permits:10');
      }),
    };
    const result = await sendPhoneCode(db, { phone: PHONE, ip: IP }, deps);
    expect(result).toMatchObject({ ok: false, status: 429, errorCode: 'SMS_RATE_LIMITED' });
  });
});

describe('验证码校验', () => {
  test('验证码过期后不可用', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const code = lastSmsCode(db, hashLookup(PHONE));

    // 默认有效期 5 分钟
    const late = verifyPhoneCode(db, { phone: PHONE, code }, { now: at(5 * 60 + 1) });
    expect(late).toMatchObject({ ok: false, status: 400, errorCode: 'OTP_EXPIRED' });

    // 4 分 59 秒时仍然有效
    const db2 = makeTestDb();
    await sendPhoneCode(db2, { phone: PHONE, ip: '198.51.100.9' }, makeDeps(T0).deps);
    const code2 = lastSmsCode(db2, hashLookup(PHONE));
    expect(verifyPhoneCode(db2, { phone: PHONE, code: code2 }, { now: at(5 * 60 - 1) }).ok).toBe(true);
  });

  test('错 5 次直接锁定该码，之后连正确验证码也不放行', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const code = lastSmsCode(db, hashLookup(PHONE));
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 1; i <= 4; i++) {
      expect(verifyPhoneCode(db, { phone: PHONE, code: wrong }, { now: at(10) })).toMatchObject({
        ok: false,
        status: 400,
        errorCode: 'OTP_INVALID',
      });
    }
    // 第 5 次错误：直接 429 锁定，不再放行下一次比对
    expect(verifyPhoneCode(db, { phone: PHONE, code: wrong }, { now: at(10) })).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'OTP_LOCKED',
    });
    expect(verifyPhoneCode(db, { phone: PHONE, code }, { now: at(10) })).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'OTP_LOCKED',
    });
  });

  test('验证码一次性：用过之后同一条不能再用', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const code = lastSmsCode(db, hashLookup(PHONE));

    expect(verifyPhoneCode(db, { phone: PHONE, code }, { now: at(10) }).ok).toBe(true);
    expect(verifyPhoneCode(db, { phone: PHONE, code }, { now: at(20) })).toMatchObject({
      ok: false,
      errorCode: 'OTP_EXPIRED',
    });
  });

  test('没发过码就来验 → OTP_NOT_FOUND；码格式不对 → OTP_INVALID', () => {
    const db = makeTestDb();
    expect(verifyPhoneCode(db, { phone: PHONE, code: '123456' }, { now: T0 })).toMatchObject({
      errorCode: 'OTP_NOT_FOUND',
    });
    expect(verifyPhoneCode(db, { phone: PHONE, code: 'abc' }, { now: T0 })).toMatchObject({
      errorCode: 'OTP_INVALID',
    });
  });
});

describe('手机验证通过后的建号与双验证', () => {
  test('首次验证建号并发 token，need_email=true；二次登录复用同一账号', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const first = verifyPhoneCode(
      db,
      { phone: PHONE, code: lastSmsCode(db, hashLookup(PHONE)) },
      { now: at(10) },
    );
    expect(first).toMatchObject({ ok: true, needEmail: true });
    const uid = verifyToken((first as { token: string }).token, at(10))!.uid;

    // 手机号只存密文 + 查找摘要，明文不落库
    const row = db.prepare('SELECT phone_enc, phone_hash FROM users WHERE id = ?').get(uid) as {
      phone_enc: string;
      phone_hash: string;
    };
    expect(row.phone_enc).not.toContain(PHONE);
    expect(row.phone_hash).toBe(hashLookup(PHONE));

    // 换个带 +86 和空格的写法再登录一次，应命中同一账号
    await sendPhoneCode(db, { phone: '+86 138 0013 8000', ip: IP }, makeDeps(at(90)).deps);
    const second = verifyPhoneCode(
      db,
      { phone: '+86 138 0013 8000', code: lastSmsCode(db, hashLookup(PHONE)) },
      { now: at(100) },
    );
    expect(second.ok).toBe(true);
    expect(verifyToken((second as { token: string }).token, at(100))!.uid).toBe(uid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  test('邮箱验证走完后 need_email 变 false，邮箱与验证时间落库', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const login = verifyPhoneCode(
      db,
      { phone: PHONE, code: lastSmsCode(db, hashLookup(PHONE)) },
      { now: at(10) },
    ) as { ok: true; token: string };
    const uid = verifyToken(login.token, at(10))!.uid;

    const { deps, email } = makeDeps(at(20));
    const sent = await sendEmailCode(db, { userId: uid, email: ' User@Example.COM ', ip: IP }, deps);
    expect(sent.ok).toBe(true);
    // 文案层默认中性：主题不得出现平台名与业务敏感词
    expect(email.mock.calls[0][1].subject).toBe(`验证码：${lastEmailCode(db, 'user@example.com')}`);

    const verified = verifyEmailCode(
      db,
      { userId: uid, email: 'user@example.com', code: lastEmailCode(db, 'user@example.com') },
      { now: at(30) },
    );
    expect(verified.ok).toBe(true);

    const row = db.prepare('SELECT email, email_verified_at FROM users WHERE id = ?').get(uid);
    expect(row).toEqual({ email: 'user@example.com', email_verified_at: at(30).toISOString() });

    // 再登录一次，不该再要求补邮箱
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(90)).deps);
    expect(
      verifyPhoneCode(db, { phone: PHONE, code: lastSmsCode(db, hashLookup(PHONE)) }, { now: at(100) }),
    ).toMatchObject({ ok: true, needEmail: false });
  });

  test('users.notify_verbose=1 时才发详细文案，默认 0 走中性文案', async () => {
    const db = makeTestDb();
    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const login = verifyPhoneCode(
      db,
      { phone: PHONE, code: lastSmsCode(db, hashLookup(PHONE)) },
      { now: at(10) },
    ) as { ok: true; token: string };
    const uid = verifyToken(login.token, at(10))!.uid;

    const neutral = makeDeps(at(20));
    await sendEmailCode(db, { userId: uid, email: 'a@b.com', ip: IP }, neutral.deps);
    expect(neutral.email.mock.calls[0][1].subject).not.toContain('裁员应对专员');

    db.prepare('UPDATE users SET notify_verbose = 1 WHERE id = ?').run(uid);
    const verbose = makeDeps(at(200));
    await sendEmailCode(db, { userId: uid, email: 'a@b.com', ip: IP }, verbose.deps);
    expect(verbose.email.mock.calls[0][1].subject).toContain('裁员应对专员');
  });

  test('邮箱已被别的账号绑定 → EMAIL_TAKEN，发码和验码两处都拦', async () => {
    const db = makeTestDb();
    db.prepare(
      "INSERT INTO users (phone_enc, phone_hash, email, email_verified_at, auth_status, created_at) VALUES ('x', 'other-hash', 'taken@example.com', ?, '未认证', ?)",
    ).run(T0.toISOString(), T0.toISOString());

    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    const login = verifyPhoneCode(
      db,
      { phone: PHONE, code: lastSmsCode(db, hashLookup(PHONE)) },
      { now: at(10) },
    ) as { ok: true; token: string };
    const uid = verifyToken(login.token, at(10))!.uid;

    expect(await sendEmailCode(db, { userId: uid, email: 'taken@example.com', ip: IP }, makeDeps(at(20)).deps)).toMatchObject({
      ok: false,
      status: 409,
      errorCode: 'EMAIL_TAKEN',
    });
    expect(
      verifyEmailCode(db, { userId: uid, email: 'taken@example.com', code: '123456' }, { now: at(20) }),
    ).toMatchObject({ ok: false, status: 409, errorCode: 'EMAIL_TAKEN' });
  });

  test('邮箱验证码同样受 60s 冷却与错 5 次锁定约束', async () => {
    const db = makeTestDb();
    const uid = Number(
      (
        db
          .prepare(
            "INSERT INTO users (phone_enc, phone_hash, auth_status, created_at) VALUES ('x', 'h', '未认证', ?)",
          )
          .run(T0.toISOString()) as { lastInsertRowid: number | bigint }
      ).lastInsertRowid,
    );
    const mail = 'a@b.com';

    expect((await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(T0).deps)).ok).toBe(true);
    expect(await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(30)).deps)).toMatchObject({
      errorCode: 'RATE_LIMITED',
      retryAfter: 60,
    });

    const code = lastEmailCode(db, mail);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 1; i <= 4; i++) {
      expect(verifyEmailCode(db, { userId: uid, email: mail, code: wrong }, { now: at(40) })).toMatchObject({
        errorCode: 'OTP_INVALID',
      });
    }
    expect(verifyEmailCode(db, { userId: uid, email: mail, code: wrong }, { now: at(40) })).toMatchObject({
      status: 429,
      errorCode: 'OTP_LOCKED',
    });
  });
});
