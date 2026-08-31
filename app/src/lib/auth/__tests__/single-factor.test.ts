// app/src/lib/auth/__tests__/single-factor.test.ts
// 单因素登录：老用户手机或邮箱**验一条就进**，两条通道各自独立可登录；
// 只有「验手机时发现这个号还没账号」＝注册，才追加一步邮箱验证把账号补全。
//
// 【判据挑的是"这次登录一共问了几样东西"，不是"接口回了 ok"】
// 「登录成功」在改造前后同样容易绿——改造前也成功，只是路上多问了一样。
// 所以每条主线都直接数 sms_codes / email_codes 两张表这次各增加了几行：
// 单因素 = 自己那条通道 +1，另一条**恒不变**。这个数改一行判定就会动。
//
// 注：手机通道那条主线在改造前就已经是单因素了（老用户 needEmail 本就为 false），
// 它是**回归护栏**而不是新判据——变异矩阵里它对邮箱侧的变异不红，属预期。
import crypto from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'better-sqlite3';

import { getGongdao } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import { hashLookup } from '@/lib/crypto';
import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';
import type { MailCopy } from '@/lib/notify';
import { verifyToken } from '../jwt';
import { sendEmailCode, sendPhoneCode, verifyEmailCode, verifyPhoneCode } from '../otp';
import { lastEmailCode, lastSmsCode, makeTestDb } from './helpers';

const PHONE = '13800138000';
const OTHER_PHONE = '13900139000';
const EMAIL = 'laoyuan@example.com';
const IP = '203.0.113.11';
const T0 = new Date('2026-08-30T09:00:00.000Z');
/** 与 lib/auth/ip-quota.ts 的 MAX_PER_WINDOW 对齐；改那边必须同步改这里 */
const IP_MAX = 300;

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** 假短信/邮件通道：真发既费钱又会打扰真实号码 */
function deps(now: Date) {
  return {
    sendSms: vi.fn(async (_phone: string, _code: string) => {}),
    sendEmail: vi.fn(async (_to: string, _copy: MailCopy) => {}),
    now,
  };
}

function count(db: Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/** 两条通道各发过几条码——「这次登录到底问了几样东西」的直接读数 */
function codeCounts(db: Database): { sms: number; email: number } {
  return {
    sms: count(db, 'SELECT COUNT(*) AS n FROM sms_codes'),
    email: count(db, 'SELECT COUNT(*) AS n FROM email_codes'),
  };
}

function tokenUid(result: unknown, now: Date): number {
  return verifyToken((result as { token: string }).token, now)!.uid;
}

/** 手机通道一轮：发码 → 验码 */
async function phoneRound(db: Database, phone: string, now: Date) {
  const sent = await sendPhoneCode(db, { phone, ip: IP }, deps(now));
  expect(sent.ok, '前置失败：手机发码没走通').toBe(true);
  return verifyPhoneCode(db, { phone, code: lastSmsCode(db, hashLookup(phone)) }, { now });
}

/** 邮箱通道一轮：发码 → 验码。userId 传 null 即匿名（＝邮箱通道登录） */
async function emailRound(db: Database, userId: number | null, email: string, now: Date) {
  const sent = await sendEmailCode(db, { userId, email, ip: IP }, deps(now));
  if (!sent.ok) return sent;
  return verifyEmailCode(db, { userId, email, code: lastEmailCode(db, email) }, { now });
}

/** 造一个注册完整走完的老用户（手机 + 邮箱都验过），返回 uid */
async function seedExistingUser(db: Database): Promise<number> {
  const login = await phoneRound(db, PHONE, T0);
  expect(login, '前置失败：建号').toMatchObject({ ok: true, needEmail: true });
  const uid = tokenUid(login, T0);
  expect((await emailRound(db, uid, EMAIL, at(30))).ok, '前置失败：补绑邮箱').toBe(true);
  return uid;
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  delete process.env.SMS_CODE_EXPIRY_MINUTES;
});

describe('老用户单因素登录', () => {
  // 回归护栏：手机侧改造前就是单因素，这条防的是「改邮箱侧时把手机侧带坏」
  test('手机通道：只发一条短信码就进站，邮箱那条通道一次都没被碰', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    const before = codeCounts(db);

    const relogin = await phoneRound(db, PHONE, at(300));
    expect(relogin).toMatchObject({ ok: true, needEmail: false });
    expect(tokenUid(relogin, at(300))).toBe(uid);

    const after = codeCounts(db);
    expect(after.sms - before.sms, '只该发这一条短信码').toBe(1);
    expect(after.email, '登录不该再问邮箱').toBe(before.email);
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
  });

  test('🔴 邮箱通道：不带 token 就能用邮箱收码登录，短信那条通道一次都没被碰', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    const before = codeCounts(db);

    // userId=null ＝ 请求里根本没有 Authorization 头。改造前这条路必然 401
    const login = await emailRound(db, null, EMAIL, at(300));
    expect(login.ok).toBe(true);
    expect(tokenUid(login, at(300)), '发的 token 必须是这个邮箱主人的').toBe(uid);

    const after = codeCounts(db);
    expect(after.email - before.email, '只该发这一条邮箱码').toBe(1);
    expect(after.sms, '走邮箱这条路不该再问手机号').toBe(before.sms);
    expect(count(db, 'SELECT COUNT(*) AS n FROM users'), '不该顺手建号').toBe(1);
  });

  test('🔴 邮箱通道登录一个字都不写库：users 整行逐列不变', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);

    expect((await emailRound(db, null, EMAIL, at(300))).ok).toBe(true);

    // 匿名请求能换到 token，但改不动任何账号——包括 email_verified_at 这种"看着无害"的列
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)).toEqual(before);
  });

  test('两条通道各自独立：同一个人换着通道登录，落到的始终是同一个账号', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);

    expect(tokenUid(await phoneRound(db, PHONE, at(300)), at(300))).toBe(uid);
    expect(tokenUid(await emailRound(db, null, EMAIL, at(600)), at(600))).toBe(uid);
    expect(tokenUid(await phoneRound(db, PHONE, at(900)), at(900))).toBe(uid);
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
  });

  test('🔴 库里有两个人时，邮箱登录落到的是这个邮箱的主人，不是排在前头那个', async () => {
    const db = makeTestDb();
    // 只有一个用户时，「落到邮箱主人」和「落到库里第一个人」看起来一模一样。
    // 第二个账号是把这两件事分开的最小装置。
    const a = await seedExistingUser(db);
    const b = tokenUid(await phoneRound(db, OTHER_PHONE, at(300)), at(300));
    const bMail = 'bieren@example.com';
    expect((await emailRound(db, b, bMail, at(360))).ok, '前置失败：B 补绑邮箱').toBe(true);

    expect(tokenUid(await emailRound(db, null, bMail, at(700)), at(700))).toBe(b);
    expect(tokenUid(await emailRound(db, null, EMAIL, at(700)), at(700))).toBe(a);
  });

  test('🔴 邮箱列有值但 email_verified_at 是空的账号，匿名冒领不了', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    // 直接造出「邮箱写进去了、但没验过」这个中间态：现在的写路径不产生它
    // （setUserEmailVerified 两列同写），但守卫不该依赖那个巧合——
    // 哪天有人先写 email 再补时间戳，这条就是唯一挡住冒领的东西。
    db.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').run(uid);

    expect(
      await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300))),
    ).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
    expect(
      verifyEmailCode(db, { userId: null, email: EMAIL, code: '123456' }, { now: at(300) }),
    ).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
  });
});

describe('新用户注册：手机 → 邮箱补全', () => {
  test('手机那一步只建号不建案，补完邮箱才算注册完成', async () => {
    const db = makeTestDb();

    const first = await phoneRound(db, PHONE, T0);
    expect(first, '查无此号 ＝ 新用户，要补邮箱').toMatchObject({ ok: true, needEmail: true });
    const uid = tokenUid(first, T0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM cases'), '注册没走完不该先把档案建出来').toBe(0);

    const done = await emailRound(db, uid, EMAIL, at(30));
    expect(done).toMatchObject({ ok: true });
    expect((done as { onboarding?: { isNew: boolean } }).onboarding).toMatchObject({ isNew: true });
    expect(count(db, 'SELECT COUNT(*) AS n FROM cases')).toBe(1);

    // 补全之后两条通道都只要一步
    expect(await phoneRound(db, PHONE, at(300))).toMatchObject({ ok: true, needEmail: false });
    expect((await emailRound(db, null, EMAIL, at(600))).ok).toBe(true);
  });

  test('🔴 中途放弃邮箱那一步的人，下次登录仍被要求补全，绕不过去', async () => {
    const db = makeTestDb();
    // 判据：needEmail 按「邮箱验过没有」判，不按「是不是这次刚建的号」判。
    // 按后者判的话，第一次关掉页面就永久跳过了邮箱——而邮箱是换手机号后找回账号的唯一落点。
    expect(await phoneRound(db, PHONE, T0)).toMatchObject({ ok: true, needEmail: true });
    expect(await phoneRound(db, PHONE, at(300))).toMatchObject({ ok: true, needEmail: true });

    // 而且这个号还不能用邮箱通道登录：它根本没绑过邮箱
    expect(
      await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(400))),
    ).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
  });
});

describe('注册赠送幂等', () => {
  test('🔴 补全 + 两条通道各登录数次，账本恒一行 reg-<uid>，余额恒 spec 值', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    expect(getGongdao(uid, db)).toBe(REGISTER_GRANT_GONGDAO);

    await phoneRound(db, PHONE, at(300));
    await emailRound(db, null, EMAIL, at(600));
    await phoneRound(db, PHONE, at(900));
    await emailRound(db, null, EMAIL, at(1200));

    expect(getGongdao(uid, db), '多走几遍登录不该把余额刷上去').toBe(REGISTER_GRANT_GONGDAO);
    const rows = db
      .prepare('SELECT type, delta, ref_id FROM gongdao_ledger WHERE user_id = ?')
      .all(uid) as { type: string; delta: number; ref_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: GONGDAO_LEDGER_TYPE.register,
      delta: REGISTER_GRANT_GONGDAO,
      ref_id: `reg-${uid}`,
    });
  });

  test('邮箱通道登录不会凭空发一笔：没走过手机注册的邮箱根本进不来，账本恒空', async () => {
    const db = makeTestDb();
    expect(
      await sendEmailCode(db, { userId: null, email: 'nobody@example.com', ip: IP }, deps(T0)),
    ).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM gongdao_ledger')).toBe(0);
  });

  test('两个人各拿各的，refId 不串号', async () => {
    const db = makeTestDb();
    const a = await seedExistingUser(db);
    const bLogin = await phoneRound(db, OTHER_PHONE, at(300));
    const b = tokenUid(bLogin, at(300));
    expect(a).not.toBe(b);
    expect(getGongdao(a, db)).toBe(REGISTER_GRANT_GONGDAO);
    expect(getGongdao(b, db)).toBe(REGISTER_GRANT_GONGDAO);
  });
});

describe('邮箱通道不放宽鉴权', () => {
  test('🔴 陌生邮箱匿名发码 → 404 EMAIL_NOT_REGISTERED，一条码都没发出去', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);
    const before = codeCounts(db);
    const mail = 'stranger@example.com';

    const result = await sendEmailCode(db, { userId: null, email: mail, ip: IP }, deps(at(300)));
    expect(result).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
    // 三段式：撞到的是什么、为什么会撞到、现在能怎么办
    const message = (result as { message: string }).message;
    expect(message).toContain('还没有账号');
    expect(message).toContain('绑定');
    expect(message).toContain('手机号');
    expect(codeCounts(db).email, '被拒时不该已经把码发出去').toBe(before.email);
  });

  test('🔴 陌生邮箱匿名验码 → 404，不建号也不发 token', async () => {
    const db = makeTestDb();
    const result = verifyEmailCode(
      db,
      { userId: null, email: 'stranger@example.com', code: '123456' },
      { now: T0 },
    );
    expect(result).toMatchObject({ ok: false, status: 404, errorCode: 'EMAIL_NOT_REGISTERED' });
    expect(result).not.toHaveProperty('token');
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  test('🔴 拿别人已绑的邮箱来验：带自己的 token 一律 EMAIL_TAKEN，人家账号一列没动', async () => {
    const db = makeTestDb();
    const a = await seedExistingUser(db);
    const b = tokenUid(await phoneRound(db, OTHER_PHONE, at(300)), at(300));
    const aBefore = db.prepare('SELECT * FROM users WHERE id = ?').get(a);

    expect(await sendEmailCode(db, { userId: b, email: EMAIL, ip: IP }, deps(at(400)))).toMatchObject(
      { ok: false, status: 409, errorCode: 'EMAIL_TAKEN' },
    );
    expect(
      verifyEmailCode(db, { userId: b, email: EMAIL, code: lastEmailCode(db, EMAIL) }, { now: at(400) }),
    ).toMatchObject({ ok: false, status: 409, errorCode: 'EMAIL_TAKEN' });

    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(a)).toEqual(aBefore);
    expect(store.findUserById(db, b)!.email, 'B 也不该被顺手绑上').toBeNull();
  });

  test('🔴 匿名邮箱登录照吃 60s 冷却与错五次锁定，一条也没松', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);

    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300)))).ok).toBe(
      true,
    );
    expect(
      await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(330))),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });

    const code = lastEmailCode(db, EMAIL);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 1; i <= 4; i++) {
      expect(
        verifyEmailCode(db, { userId: null, email: EMAIL, code: wrong }, { now: at(340) }),
      ).toMatchObject({ ok: false, status: 400, errorCode: 'OTP_INVALID' });
    }
    expect(
      verifyEmailCode(db, { userId: null, email: EMAIL, code: wrong }, { now: at(340) }),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'OTP_LOCKED' });
    // 锁上之后连正确的码也不放行
    expect(
      verifyEmailCode(db, { userId: null, email: EMAIL, code }, { now: at(340) }),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'OTP_LOCKED' });
  });

  test('匿名邮箱登录的码是一次性的：用过之后同一条换不来第二个 token', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);
    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300)))).ok).toBe(
      true,
    );
    const code = lastEmailCode(db, EMAIL);

    expect(verifyEmailCode(db, { userId: null, email: EMAIL, code }, { now: at(310) }).ok).toBe(true);
    expect(
      verifyEmailCode(db, { userId: null, email: EMAIL, code }, { now: at(320) }),
    ).toMatchObject({ ok: false, errorCode: 'OTP_EXPIRED' });
  });
});

describe('IP 配额逻辑不变', () => {
  test('老用户邮箱登录仍走豁免（既不判也不记），同 IP 上陌生号码那堵墙还在', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);
    // 同事们把这个出口 IP 的额度用光
    const ins = db.prepare('INSERT INTO ip_quota_events (ip, created_at) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < IP_MAX; i++) ins.run(IP, toSql(T0));
    })();
    const before = count(db, 'SELECT COUNT(*) AS n FROM ip_quota_events WHERE ip = ?', IP);

    expect((await emailRound(db, null, EMAIL, at(300))).ok).toBe(true);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ip_quota_events WHERE ip = ?', IP)).toBe(before);

    // 豁免没有把墙拆了
    expect(await sendPhoneCode(db, { phone: OTHER_PHONE, ip: IP }, deps(at(300)))).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'RATE_LIMITED',
    });
  });
});
