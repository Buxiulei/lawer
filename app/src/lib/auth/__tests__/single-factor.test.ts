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
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);

    // 发码这一步与「已注册」同形（问不出注册状态），但发出去的是引导信、库里那条码没人收得到
    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300)))).ok).toBe(
      true,
    );
    // 判据故意**把库里那条码直接喂回去**：连知道码的人都换不到 token，
    // 才叫「冒领不了」——只要有一处把 user 认成了这个账号，这里立刻变成 ok:true。
    expect(
      verifyEmailCode(
        db,
        { userId: null, email: EMAIL, code: lastEmailCode(db, EMAIL) },
        { now: at(310) },
      ),
    ).toMatchObject({ ok: false, status: 400, errorCode: 'OTP_INVALID' });
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)).toEqual(before);
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

    // 而且这个号还不能用邮箱通道登录：它根本没绑过邮箱。
    // 发码那一步照样回 ok（不泄露注册状态），但库里那条码换不到 token。
    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(400)))).ok).toBe(
      true,
    );
    expect(
      verifyEmailCode(
        db,
        { userId: null, email: EMAIL, code: lastEmailCode(db, EMAIL) },
        { now: at(410) },
      ),
    ).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });
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
    const mail = 'nobody@example.com';
    // 发码回 ok（与已注册同形），但走完全程也建不出账号、发不出赠送
    expect((await sendEmailCode(db, { userId: null, email: mail, ip: IP }, deps(T0))).ok).toBe(true);
    expect(
      verifyEmailCode(db, { userId: null, email: mail, code: lastEmailCode(db, mail) }, { now: at(10) }),
    ).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });
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
  test('🔴 陌生邮箱匿名验码：不建号也不发 token', async () => {
    const db = makeTestDb();
    const result = verifyEmailCode(
      db,
      { userId: null, email: 'stranger@example.com', code: '123456' },
      { now: T0 },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'OTP_NOT_FOUND' });
    expect(result).not.toHaveProperty('token');
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  test('🔴 带 token 但这个 uid 在库里不存在 → 401，不落到邮箱主人头上', async () => {
    const db = makeTestDb();
    const uid = await seedExistingUser(db);
    const ghost = uid + 999; // 注销 / 清库之后 token 还在手里，就是这个形状
    const before = codeCounts(db);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);

    // 邮箱有主：**这一条把「401 缺失」和「EMAIL_TAKEN 顶上」分了开**——
    // 去掉 !user 那道守卫，下一句 owner.id !== userId 会把它变成 409，判据立刻红。
    for (const result of [
      await sendEmailCode(db, { userId: ghost, email: EMAIL, ip: IP }, deps(at(300))),
      verifyEmailCode(db, { userId: ghost, email: EMAIL, code: '123456' }, { now: at(300) }),
    ]) {
      expect(result).toMatchObject({ ok: false, status: 401, errorCode: 'UNAUTHORIZED' });
    }
    // 邮箱没主：不许静默降级成匿名那条路（那样陌生邮箱会回 ok），也不许崩
    for (const result of [
      await sendEmailCode(db, { userId: ghost, email: 'wuzhu@example.com', ip: IP }, deps(at(300))),
      verifyEmailCode(db, { userId: ghost, email: 'wuzhu@example.com', code: '123456' }, { now: at(300) }),
    ]) {
      expect(result).toMatchObject({ ok: false, status: 401, errorCode: 'UNAUTHORIZED' });
    }

    expect(codeCounts(db).email, '401 时一条码都不该发').toBe(before.email);
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)).toEqual(owner);
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

/**
 * 【邮箱通道不能是注册状态探针】manager 2026-08-31 裁定：对齐手机通道。
 *
 * 改造第一版里，陌生邮箱在**任何限流之前**就回 404 EMAIL_NOT_REGISTERED——
 * 拿任意邮箱打一次接口就能问出「这个人是不是我们的用户」，零成本、可批量。
 * 对本站来说这不是一般的隐私泄漏：这份名单本身就说明这些人正在维权。
 * 手机通道从来不泄露这件事（陌生号码照发照收），邮箱通道不该自己开这个口。
 *
 * 所以判据钉的是**同形**：已注册与未注册邮箱走匿名登录，响应逐字段相等。
 * 打错字的真人不靠错误码得到解释——引导信 + 登录页常驻提示（见 LoginFlow 判据）。
 */
describe('邮箱通道不是注册状态探针', () => {
  test('🔴 已注册与未注册邮箱的登录响应逐字段同形，发码与验码两处都是', async () => {
    const db = makeTestDb();
    await seedExistingUser(db); // EMAIL 已注册
    const before = codeCounts(db);
    const stranger = 'stranger@example.com';

    const known = await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300)));
    const unknown = await sendEmailCode(db, { userId: null, email: stranger, ip: IP }, deps(at(300)));
    expect(unknown, '发码响应只要有一处不一样，就够拿来枚举了').toEqual(known);
    expect(codeCounts(db).email - before.email, '两边都得落一行，否则验码那边会分叉').toBe(2);

    // 验码这一处同样要同形：同一条错码打过去，回答一模一样。
    // '000000' 不可能撞上真码——generateCode 取 100000..999999。
    const kv = verifyEmailCode(db, { userId: null, email: EMAIL, code: '000000' }, { now: at(310) });
    const uv = verifyEmailCode(db, { userId: null, email: stranger, code: '000000' }, { now: at(310) });
    expect(uv, '验码响应分叉一样能枚举').toEqual(kv);
    expect(uv).toMatchObject({ ok: false, errorCode: 'OTP_INVALID' });
  });

  test('🔴 差别只落在信里：陌生邮箱收到的是引导信而不是码', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);

    const cold = deps(at(300));
    expect(
      (await sendEmailCode(db, { userId: null, email: 'stranger@example.com', ip: IP }, cold)).ok,
    ).toBe(true);
    expect(cold.sendEmail).toHaveBeenCalledTimes(1);
    const strangerCopy = cold.sendEmail.mock.calls[0][1];
    expect(strangerCopy.text, '引导信里不许带码，否则谁都能拿别人的邮箱试').not.toMatch(/\d{6}/);
    expect(strangerCopy.text, '打错字的真人要在收件箱里拿到解释').toContain('还没有账号');

    // 已注册的那封是带码的验证码信——两封不是同一封，只是接口分不出来
    const warm = deps(at(300));
    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, warm)).ok).toBe(true);
    expect(warm.sendEmail.mock.calls[0][1].text).toMatch(/\d{6}/);
  });

  /**
   * 探测要有成本，成本就是既有的 IP 配额那条——**一行都没改**，只是陌生邮箱不再提前 return，
   * 于是自然落到 knownUser=false 那一支，与陌生手机号完全一样。
   *
   * 【留一句实话】IP 额度打满之后，陌生邮箱会 429 而老用户仍豁免，两者在那一刻可分辨。
   * 这是配额本身的可见性，手机通道有一模一样的性质（老号豁免、陌生号被拦），
   * 不是邮箱通道额外开的口子；要消掉它得改配额语义，那是另一件事。
   */
  test('🔴 探测有成本：陌生邮箱照吃 IP 配额，已注册邮箱登录仍豁免', async () => {
    const db = makeTestDb();
    await seedExistingUser(db);
    const ipRows = () => count(db, 'SELECT COUNT(*) AS n FROM ip_quota_events WHERE ip = ?', IP);
    const before = ipRows();

    expect(
      (await sendEmailCode(db, { userId: null, email: 'stranger@example.com', ip: IP }, deps(at(300))))
        .ok,
    ).toBe(true);
    expect(ipRows(), '陌生邮箱与陌生手机号一样占额度').toBe(before + 1);

    expect((await sendEmailCode(db, { userId: null, email: EMAIL, ip: IP }, deps(at(300)))).ok).toBe(
      true,
    );
    expect(ipRows(), '老用户回来登录仍不占额度').toBe(before + 1);
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
