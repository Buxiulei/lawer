// app/src/lib/auth/__tests__/email-register.test.ts
// 邮箱注册（无手机号）：邮箱 + 验证码即可开户，与 nbdpsy 同形。
//
// 【判据取向】不测「函数被调用了」「表里有行」这类接线痕迹——那种断言在功能坏掉之后
// 照样容易写、照样绿。这里的判据一律取**用户那一侧真的能不能用**：
//   开户判据 = 新账号过得了 gongdaoGate（余额 0 的账号第一个计费动作就被拦，
//              而它看起来一切正常，人只会以为产品坏了——2026-08-28 产线实况）；
//   隔离判据 = 一桶的码拿到另一桶去**验不过**，且各自在自己那桶里**验得过**
//              （只测前半句的话，"两桶都失效"也能让它绿）；
//   限流判据 = 两条路由交替点也绕不开 60 秒冷却与 10 次/日。
import crypto from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'better-sqlite3';

import { getGongdao, gongdaoGate } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import { hashLookup } from '@/lib/crypto';
import * as store from '@/lib/db/otp';
import { emailVerifyCode } from '@/lib/notify';
import type { MailCopy } from '@/lib/notify';
import { verifyToken } from '../jwt';
import {
  sendEmailCode,
  sendEmailRegisterCode,
  sendPhoneCode,
  verifyEmailCode,
  verifyEmailRegisterCode,
  verifyPhoneCode,
} from '../otp';
import { lastEmailCode, lastSmsCode, makeTestDb } from './helpers';

const EMAIL = 'zhang.san@example.com';
const IP = '203.0.113.11';
const T0 = new Date('2026-08-29T09:00:00.000Z');
/** 与 lib/auth/ip-quota.ts 的 MAX_PER_WINDOW 对齐；改那边必须同步改这里 */
const IP_MAX = 300;
/** otp.ts 的 codeExpiryMinutes() 缺省值（beforeEach 已删掉 SMS_CODE_EXPIRY_MINUTES） */
const DEFAULT_EXPIRY_MINUTES = 5;

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

/** 第 i 个测试邮箱（灌 IP 配额用，互不相同） */
function nthEmail(i: number): string {
  return `user${i}@example.com`;
}

function makeDeps(now: Date) {
  const email = vi.fn(async (_to: string, _copy: MailCopy) => {});
  const sms = vi.fn(async (_phone: string, _code: string) => {});
  return { deps: { sendEmail: email, sendSms: sms, now }, email, sms };
}

/** 走完整的「发注册码 → 验注册码」开户流程 */
async function registerByEmail(
  db: Database,
  email = EMAIL,
  now = T0,
  ip = IP,
): Promise<{ uid: number; token: string; isNewUser: boolean }> {
  const sent = await sendEmailRegisterCode(db, { email, ip }, makeDeps(now).deps);
  expect(sent.ok, '前置失败：注册码没发出去').toBe(true);
  const code = lastEmailCode(db, email.trim().toLowerCase(), store.EMAIL_PURPOSE.register);
  const res = verifyEmailRegisterCode(db, { email, code }, { now });
  if (!res.ok) throw new Error(`前置失败：开户没走通（${res.errorCode}）`);
  const uid = verifyToken(res.token, now)!.uid;
  return { uid, token: res.token, isNewUser: res.isNewUser };
}

/** 造一个「手机注册 + 已绑邮箱」的存量账号，用来测两条路径撞在一起时的行为 */
async function registerByPhoneThenEmail(
  db: Database,
  phone: string,
  email: string,
  now = T0,
): Promise<number> {
  await sendPhoneCode(db, { phone, ip: IP }, makeDeps(now).deps);
  const verified = verifyPhoneCode(db, { phone, code: lastSmsCode(db, hashLookup(phone)) }, { now });
  if (!verified.ok) throw new Error('前置失败：手机建号没走通');
  const uid = verifyToken(verified.token, now)!.uid;
  await sendEmailCode(db, { userId: uid, email, ip: IP }, makeDeps(now).deps);
  const bound = verifyEmailCode(
    db,
    { userId: uid, email, code: lastEmailCode(db, email, store.EMAIL_PURPOSE.verify) },
    { now },
  );
  if (!bound.ok) throw new Error('前置失败：绑邮箱没走通');
  return uid;
}

function userRow(db: Database, uid: number) {
  return db
    .prepare('SELECT phone_enc, phone_hash, email, email_verified_at, phone_verified_at FROM users WHERE id = ?')
    .get(uid) as {
    phone_enc: string | null;
    phone_hash: string | null;
    email: string | null;
    email_verified_at: string | null;
    phone_verified_at: string | null;
  };
}

function ledgerRows(db: Database, uid: number) {
  return db
    .prepare('SELECT type, delta, ref_id FROM gongdao_ledger WHERE user_id = ?')
    .all(uid) as { type: string; delta: number; ref_id: string }[];
}

function seedIpEvents(db: Database, ip: string, n: number, when: Date): void {
  const ins = db.prepare('INSERT INTO ip_quota_events (ip, created_at) VALUES (?, ?)');
  const iso = when.toISOString().replace('T', ' ').slice(0, 19);
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(ip, iso);
  })();
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  delete process.env.SMS_CODE_EXPIRY_MINUTES;
  vi.restoreAllMocks();
});

describe('开户：邮箱 + 验证码，无手机号', () => {
  test('🔴 开完户就能过计费门槛（这是判据本身，不是「账本有行」）', async () => {
    const db = makeTestDb();
    const { uid } = await registerByEmail(db);
    expect(gongdaoGate(uid, db)).toBe(true);
    expect(getGongdao(uid, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('落库形态：只有邮箱，手机两列都是 NULL，邮箱当场标为已验证', async () => {
    const db = makeTestDb();
    const { uid } = await registerByEmail(db);
    expect(userRow(db, uid)).toMatchObject({
      phone_enc: null,
      phone_hash: null,
      email: EMAIL,
      phone_verified_at: null,
    });
    expect(userRow(db, uid).email_verified_at).toBeTruthy();
  });

  test('两个「没手机号」的账号能并存（phone_hash 唯一索引是部分索引，多个 NULL 不算重复）', async () => {
    const db = makeTestDb();
    const a = await registerByEmail(db, 'a@example.com', T0);
    const b = await registerByEmail(db, 'b@example.com', at(120));
    expect(a.uid).not.toBe(b.uid);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM users WHERE phone_hash IS NULL').get() as { c: number }).c,
    ).toBe(2);
    // 各拿各的赠送，refId 不串号
    expect(getGongdao(a.uid, db)).toBe(REGISTER_GRANT_GONGDAO);
    expect(getGongdao(b.uid, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('账本落的是「注册赠送」这一类，refId = reg-<uid>，一行', async () => {
    const db = makeTestDb();
    const { uid } = await registerByEmail(db);
    const rows = ledgerRows(db, uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: GONGDAO_LEDGER_TYPE.register,
      delta: REGISTER_GRANT_GONGDAO,
      ref_id: `reg-${uid}`,
    });
  });

  test('同一邮箱再走一遍 = 登录：同一个 uid，不二次发放，is_new_user 转 false', async () => {
    const db = makeTestDb();
    const first = await registerByEmail(db, EMAIL, T0);
    expect(first.isNewUser).toBe(true);

    const second = await registerByEmail(db, EMAIL, at(120));
    expect(second.uid).toBe(first.uid);
    expect(second.isNewUser).toBe(false);
    expect(getGongdao(first.uid, db)).toBe(REGISTER_GRANT_GONGDAO);
    expect(ledgerRows(db, first.uid)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
  });

  test('建号与赠送同生同死：赠送炸了就不该留下一个用不了的账号', async () => {
    const db = makeTestDb();
    const real = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO gongdao_ledger')) {
        throw new Error('模拟账本写入失败');
      }
      return real(sql);
    }) as typeof db.prepare);

    await expect(registerByEmail(db)).rejects.toThrow();
    vi.restoreAllMocks();

    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(0);
  });

  test('邮箱大小写与首尾空白归一：发码与验码写法不同也是同一个账号', async () => {
    const db = makeTestDb();
    const sent = await sendEmailRegisterCode(
      db,
      { email: '  ZhangSan@Example.COM ', ip: IP },
      makeDeps(T0).deps,
    );
    expect(sent.ok).toBe(true);

    const code = lastEmailCode(db, 'zhangsan@example.com', store.EMAIL_PURPOSE.register);
    const res = verifyEmailRegisterCode(db, { email: 'ZHANGSAN@example.com', code }, { now: T0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(userRow(db, verifyToken(res.token, T0)!.uid).email).toBe('zhangsan@example.com');
  });

  test('签出来的 token 验得过，且 uid 就是这个账号', async () => {
    const db = makeTestDb();
    const { uid, token } = await registerByEmail(db);
    expect(verifyToken(token, T0)).toMatchObject({ uid });
  });
});

describe('开户即开通默认案件', () => {
  test('新账号 → 建默认案件 + 欢迎事件，onboarding.isNew=true', async () => {
    const db = makeTestDb();
    const sent = await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps);
    expect(sent.ok).toBe(true);
    const res = verifyEmailRegisterCode(
      db,
      { email: EMAIL, code: lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register) },
      { now: T0 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.onboarding).toMatchObject({ isNew: true });

    const uid = verifyToken(res.token, T0)!.uid;
    const kase = db.prepare('SELECT id, title FROM cases WHERE user_id = ?').get(uid) as {
      id: number;
      title: string;
    };
    expect(kase.title).toBe('我的案件');
    expect(res.onboarding!.caseId).toBe(kase.id);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM timeline_events WHERE case_id = ?').get(kase.id) as {
        c: number;
      }).c,
    ).toBe(1);
  });

  test('第二次登录不重复建案，onboarding.isNew=false', async () => {
    const db = makeTestDb();
    const { uid } = await registerByEmail(db, EMAIL, T0);
    const sent = await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(at(120)).deps);
    expect(sent.ok).toBe(true);
    const again = verifyEmailRegisterCode(
      db,
      { email: EMAIL, code: lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register) },
      { now: at(120) },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.onboarding).toMatchObject({ isNew: false });
    expect(
      (db.prepare('SELECT COUNT(*) c FROM cases WHERE user_id = ?').get(uid) as { c: number }).c,
    ).toBe(1);
  });

  test('建案失败不阻断开户：照样发 token，账号与赠送都在，不留半截档案', async () => {
    const db = makeTestDb();
    const sent = await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps);
    expect(sent.ok).toBe(true);
    db.exec('DROP TABLE timeline_events');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = verifyEmailRegisterCode(
      db,
      { email: EMAIL, code: lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register) },
      { now: T0 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.token).toBeTruthy();
    expect(res.onboarding).toBeUndefined();
    expect(logged).toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) c FROM cases').get() as { c: number }).c).toBe(0);
    // 账号本身照常成立，且赠送已到账
    const uid = verifyToken(res.token, T0)!.uid;
    expect(gongdaoGate(uid, db)).toBe(true);
  });
});

describe('两桶验证码互不通用（改流程不改强度）', () => {
  test('注册码不能拿去当「绑定码」用，绑定码也不能拿去开户；各自在本桶里照旧好使', async () => {
    const db = makeTestDb();
    // 存量账号：手机注册 + 已绑另一个邮箱，用来调 sendEmailCode
    const uid = await registerByPhoneThenEmail(db, '13800138000', 'bound@example.com', T0);

    // 同一个目标邮箱，两桶各发一条
    const target = 'cross@example.com';
    const sentVerify = await sendEmailCode(
      db,
      { userId: uid, email: target, ip: IP },
      makeDeps(at(120)).deps,
    );
    expect(sentVerify.ok, '前置失败：绑定码没发出去').toBe(true);
    const verifyCode = lastEmailCode(db, target, store.EMAIL_PURPOSE.verify);

    const sentRegister = await sendEmailRegisterCode(
      db,
      { email: target, ip: IP },
      makeDeps(at(240)).deps,
    );
    expect(sentRegister.ok, '前置失败：注册码没发出去').toBe(true);
    const registerCode = lastEmailCode(db, target, store.EMAIL_PURPOSE.register);
    expect(registerCode).not.toBe(verifyCode);

    // ① 拿注册码走绑定流程 → 验不过（这一桶里没有它）
    expect(
      verifyEmailCode(db, { userId: uid, email: target, code: registerCode }, { now: at(250) }),
    ).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });

    // ② 拿绑定码走开户流程 → 验不过
    expect(
      verifyEmailRegisterCode(db, { email: target, code: verifyCode }, { now: at(250) }),
    ).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });

    // ③ 对照臂：各自在自己那桶里必须验得过。少了这一条，「两桶都坏掉」也能让 ①② 绿。
    expect(
      verifyEmailRegisterCode(db, { email: target, code: registerCode }, { now: at(250) }).ok,
    ).toBe(true);
  });

  test('注册桶没发过码时验码 → OTP_NOT_FOUND（不会误命中绑定桶里那条）', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneThenEmail(db, '13800138000', 'bound@example.com', T0);
    const target = 'onlyverify@example.com';
    await sendEmailCode(db, { userId: uid, email: target, ip: IP }, makeDeps(at(120)).deps);

    expect(
      verifyEmailRegisterCode(db, { email: target, code: '123456' }, { now: at(130) }),
    ).toMatchObject({ ok: false, status: 400, errorCode: 'OTP_NOT_FOUND' });
  });
});

/**
 * ══════════════ 具名契约 · 存量已绑邮箱账号可凭该邮箱码登录 ══════════════
 *
 * 【裁决】manager 2026-08-31：**确认保留**。依据是用户原话「只需要手机号或者邮箱一种验证」——
 * 一个手机注册、后来绑过邮箱的老用户，换了手机号/收不到短信时，凭那个邮箱收码就该进得来。
 *
 * 【为什么从「顺带」升成具名契约】上一版它只是「两桶验证码互不通用」那一节里的一条附带断言，
 * 名字讲的是**克隆不克隆账号**，读起来像在防一个 bug，看不出它其实是一条被裁定过的产品行为。
 * 一条没人认得出是契约的判据，合并/重构时会被当成实现细节顺手删掉——而它一旦没了，
 * 现象是「老用户用邮箱登录突然变成开了个新号」，没有任何东西会报红。
 *
 * 【与 single-factor 那一支的口径对齐】那边（app/src/lib/auth/__tests__/single-factor.test.ts）
 * 有一条同源判据：「🔴 邮箱通道：不带 token 就能用邮箱收码登录，短信那条通道一次都没被碰」。
 * 两条讲的是同一件事在两条路由上的两个切面：
 *   single-factor → /api/v1/auth/email/{send,verify} 匿名化后的老用户登录；
 *   本支         → /api/v1/auth/email/register/{send,verify} 撞上存量邮箱时不建新号、直接登录。
 * **合并轮不许其中任何一支把对方那条改没**：两支都在改 lib/auth/otp.ts，冲突解到哪一边都行，
 * 但解完之后这两条测试必须都还在、都还绿。少了任何一条，「邮箱能不能当独立入口」就回到了
 * 「谁也没测、看起来都对」的状态。
 */
describe('【契约】存量已绑邮箱账号可凭该邮箱码登录（manager 2026-08-31 确认保留）', () => {
  test('🔴 手机注册 + 已绑邮箱的老用户走开户路由 = 登录同一个账号：不克隆、不二次赠送、手机号还在', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneThenEmail(db, '13800138000', EMAIL, T0);
    const before = userRow(db, uid);

    const again = await registerByEmail(db, EMAIL, at(300));

    expect(again.uid, '落到的不是同一个账号').toBe(uid);
    expect(again.isNewUser, '老用户被当成了新人').toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
    // 赠送只发过一次（手机那次），补登录不再发
    expect(ledgerRows(db, uid)).toHaveLength(1);
    // **手机那一因子不许被这次邮箱登录抹掉**：抹了的话他下次用手机号就登不回来了，
    // 而「换个通道也能进」正是这条契约存在的理由。
    expect(userRow(db, uid)).toEqual(before);
  });
});

describe('发码限流（一个信箱只有一份额度）', () => {
  test('同一邮箱 60s 内只能再发一次，重发 retry_after: 60', async () => {
    const db = makeTestDb();
    expect((await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps)).ok).toBe(
      true,
    );
    expect(
      await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(at(59)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });
    expect((await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(at(61)).deps)).ok).toBe(
      true,
    );
  });

  test('🔴 冷却跨桶生效：刚发过绑定码，60s 内换注册路由同一邮箱照样被拒', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneThenEmail(db, '13800138000', 'bound@example.com', T0);
    const target = 'shared@example.com';
    expect(
      (await sendEmailCode(db, { userId: uid, email: target, ip: IP }, makeDeps(at(120)).deps)).ok,
    ).toBe(true);

    // 换一条路由就重新起算的话，攻击者交替点两条路由即可无限发信
    expect(
      await sendEmailRegisterCode(db, { email: target, ip: IP }, makeDeps(at(150)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });
    expect(
      (await sendEmailRegisterCode(db, { email: target, ip: IP }, makeDeps(at(181)).deps)).ok,
    ).toBe(true);
  });

  test('🔴 24h 上限跨桶合计 10 次：两条路由各 5 次之后第 11 次被拒', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneThenEmail(db, '13800138000', 'bound@example.com', T0);
    const target = 'shared@example.com';
    for (let i = 0; i < 5; i++) {
      const r = await sendEmailCode(
        db,
        { userId: uid, email: target, ip: IP },
        makeDeps(at(120 + i * 120)).deps,
      );
      expect(r.ok, `绑定码第 ${i + 1} 次不该被拒`).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      const r = await sendEmailRegisterCode(
        db,
        { email: target, ip: IP },
        makeDeps(at(720 + i * 120)).deps,
      );
      expect(r.ok, `注册码第 ${i + 1} 次不该被拒`).toBe(true);
    }
    const eleventh = await sendEmailRegisterCode(
      db,
      { email: target, ip: IP },
      makeDeps(at(1320)).deps,
    );
    expect(eleventh).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
    // 日上限没有"再等 60 秒"这一说，不给 retry_after
    expect((eleventh as { retryAfter?: number }).retryAfter).toBeUndefined();
  });

  test('同一 IP 24h 内最多 300 次（换邮箱也挡），第 301 次被拒且说清怎么绕开', async () => {
    const db = makeTestDb();
    for (let i = 0; i < IP_MAX; i++) {
      const r = await sendEmailRegisterCode(db, { email: nthEmail(i), ip: IP }, makeDeps(T0).deps);
      expect(r.ok, `第 ${i + 1} 次不该被拒`).toBe(true);
    }
    const blocked = await sendEmailRegisterCode(
      db,
      { email: 'overflow@example.com', ip: IP },
      makeDeps(T0).deps,
    );
    expect(blocked).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
    expect((blocked as { message: string }).message).toContain('出口 IP');
    expect((blocked as { message: string }).message).toContain('手机流量');

    // 换 IP 不受影响，说明确实按 IP 分桶而不是全局桶
    expect(
      (
        await sendEmailRegisterCode(
          db,
          { email: 'overflow@example.com', ip: '198.51.100.9' },
          makeDeps(T0).deps,
        )
      ).ok,
    ).toBe(true);
  });

  test('存量已验证邮箱免 IP 配额（同事把额度用光，老用户照样登录），新邮箱照旧被挡', async () => {
    const db = makeTestDb();
    await registerByEmail(db, EMAIL, T0);
    seedIpEvents(db, IP, IP_MAX, T0);

    // 老用户回来：IP 已满仍放行（按邮箱的两条限流照旧全额生效，故推过 60s）
    expect((await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(at(120)).deps)).ok).toBe(
      true,
    );
    // 对照臂：同一个 IP 上的新邮箱必须被挡，否则「豁免」等于把 IP 限流整条关掉
    expect(
      await sendEmailRegisterCode(db, { email: 'stranger@example.com', ip: IP }, makeDeps(at(120)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
  });
});

describe('验码的边界与失败形态', () => {
  test('没发过码就验 → OTP_NOT_FOUND；不建号', async () => {
    const db = makeTestDb();
    expect(verifyEmailRegisterCode(db, { email: EMAIL, code: '123456' }, { now: T0 })).toMatchObject(
      { ok: false, status: 400, errorCode: 'OTP_NOT_FOUND' },
    );
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(0);
  });

  test('邮箱格式不对 → INVALID_EMAIL；验证码不是 6 位数字 → OTP_INVALID', async () => {
    const db = makeTestDb();
    expect(verifyEmailRegisterCode(db, { email: 'not-an-email', code: '123456' })).toMatchObject({
      ok: false,
      status: 400,
      errorCode: 'INVALID_EMAIL',
    });
    expect(await sendEmailRegisterCode(db, { email: 'not-an-email', ip: IP })).toMatchObject({
      ok: false,
      status: 400,
      errorCode: 'INVALID_EMAIL',
    });
    for (const bad of ['12345', '1234567', 'abcdef', '']) {
      expect(verifyEmailRegisterCode(db, { email: EMAIL, code: bad })).toMatchObject({
        ok: false,
        errorCode: 'OTP_INVALID',
      });
    }
  });

  test('码只能用一次：同一串码第二次验 → OTP_EXPIRED，不会重复开户', async () => {
    const db = makeTestDb();
    const sent = await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps);
    expect(sent.ok).toBe(true);
    const code = lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register);

    expect(verifyEmailRegisterCode(db, { email: EMAIL, code }, { now: T0 }).ok).toBe(true);
    expect(verifyEmailRegisterCode(db, { email: EMAIL, code }, { now: at(10) })).toMatchObject({
      ok: false,
      status: 400,
      errorCode: 'OTP_EXPIRED',
    });
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
  });

  test('过期码验不过（默认 5 分钟）', async () => {
    const db = makeTestDb();
    await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps);
    const code = lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register);
    expect(verifyEmailRegisterCode(db, { email: EMAIL, code }, { now: at(301) })).toMatchObject({
      ok: false,
      errorCode: 'OTP_EXPIRED',
    });
  });

  test('错 5 次锁死：第 5 次直接 OTP_LOCKED，之后连正确的码也不放行', async () => {
    const db = makeTestDb();
    await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps);
    const code = lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register);
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < 4; i++) {
      expect(
        verifyEmailRegisterCode(db, { email: EMAIL, code: wrong }, { now: at(10) }),
        `第 ${i + 1} 次错码`,
      ).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });
    }
    expect(
      verifyEmailRegisterCode(db, { email: EMAIL, code: wrong }, { now: at(10) }),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'OTP_LOCKED' });
    // 锁死之后正确的码也不认，否则爆破只是多花一次请求
    expect(verifyEmailRegisterCode(db, { email: EMAIL, code }, { now: at(10) })).toMatchObject({
      ok: false,
      errorCode: 'OTP_LOCKED',
    });
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(0);
  });

  // 【这条判据 2026-09-03 被 F-204 翻面】旧版断言的是「发信失败也占掉一次额度」，
  // 理由写的是「上游持续报错时不会被无限重试打爆」。代价是用户读到「稍后再试」、
  // 照做立刻再点，收到的却是「发送太频繁，60 秒后再试」——两句话互相打架，
  // 上游抖动时就成了「报错→等 60 秒→再报错」的死循环。发送本身没成功，
  // 不该算在用户的额度上；拦无限重试的活交给出口 IP 那条计数（失败照记不退）。
  test('🔴 发信失败 → EMAIL_SEND_FAILED，且不占额度：立刻重发就能成（F-204）', async () => {
    const db = makeTestDb();
    const rows = () =>
      (db.prepare('SELECT COUNT(*) c FROM email_codes WHERE email = ?').get(EMAIL) as { c: number })
        .c;

    const res = await sendEmailRegisterCode(
      db,
      { email: EMAIL, ip: IP },
      {
        now: T0,
        sendEmail: async () => {
          throw new Error('SMTP 挂了');
        },
      },
    );
    expect(res).toMatchObject({ ok: false, status: 502, errorCode: 'EMAIL_SEND_FAILED' });
    expect(rows(), '发失败还留着行 = 当日额度被白吃一次').toBe(0);

    // 同一秒立刻重发：不该撞上 60 秒冷却
    expect(
      (await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(T0).deps)).ok,
      '发失败后立刻重发被拦 = F-204 复发',
    ).toBe(true);
    expect(rows()).toBe(1);

    // 反向对照：真发出去的那次照旧起 60 秒冷却
    expect(
      await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, makeDeps(at(1)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });
  });

  test('🔴 发出去的邮件恒用中性文案：把这里改成 detailed 会红（匿名收件人可能还不是我们的用户）', async () => {
    // 【为什么原来那句不算判据】上一版只断言 `subject 不含「账号」` + `text 含验证码`。
    // 把调用处改成 `emailVerifyCode(code, minutes, { detailed: true })` 后，主题变成
    // 「土八鼠 邮箱验证码：123456」——不含「账号」二字，正文照样含码，**两句全绿**。
    // 也就是说 copy.ts 顶部那条产品红线（出站文案不许露出平台名）在这条新路径上没有闸。
    //
    // 【改成钉哪一句】不在这里重抄一遍敏感词清单——那份清单归 notify/__tests__/copy.test.ts，
    // 抄第二份只会各自漂移。这里钉的是**调用处选了哪一种文案**：必须逐字等于中性版。
    // 单这一句仍可能假绿（若 copy.ts 哪天把两种模式退化成同一份文案），所以先证两者确实不同。
    const db = makeTestDb();
    const { deps, email } = makeDeps(T0);
    await sendEmailRegisterCode(db, { email: EMAIL, ip: IP }, deps);
    expect(email).toHaveBeenCalledTimes(1);
    const [to, copy] = email.mock.calls[0] as unknown as [string, MailCopy];
    expect(to).toBe(EMAIL);

    const code = lastEmailCode(db, EMAIL, store.EMAIL_PURPOSE.register);
    const neutral = emailVerifyCode(code, DEFAULT_EXPIRY_MINUTES);
    const detailed = emailVerifyCode(code, DEFAULT_EXPIRY_MINUTES, { detailed: true });
    expect(detailed, '两种模式退化成同一份文案，下面那句就不再有鉴别力').not.toEqual(neutral);
    expect(copy).toEqual(neutral);
    // 验证码本身照旧必须在信里，否则「中性」可以靠什么都不写来达成
    expect(copy.text).toContain(code);
  });
});
