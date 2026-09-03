// app/src/lib/auth/__tests__/otp.test.ts
// 限流是这个模块唯一挡住「短信被刷爆 / 验证码被爆破」的东西，四条规则各一例，一条都不能松。
// 全程 mock 短信与邮件发送：真发既费钱又会打扰真实号码。
import { toSql } from '@/lib/db/time';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { hashLookup } from '@/lib/crypto';
import type { MailCopy } from '@/lib/notify';
import {
  sendEmailCode,
  sendEmailRegisterCode,
  sendPhoneCode,
  verifyEmailCode,
  verifyPhoneCode,
} from '../otp';
import { verifyToken } from '../jwt';
import { lastEmailCode, lastSmsCode, makeTestDb } from './helpers';

// 本文件每条用例都要建一个真库跑一整套迁移，再灌上百条限流流水；单跑就已实耗数秒，
// 而全量跑批里它和几十个同样吃 CPU 的文件挤在一起，默认 5s 的余量不够——超时红过，
// 但代码一行没错。放宽的**只是这个文件**：全局改宽会把真慢化一起盖掉。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PHONE = '13800138000';
const IP = '203.0.113.7';
const T0 = new Date('2026-08-19T10:00:00.000Z');
/** 与 lib/auth/ip-quota.ts 的 MAX_PER_WINDOW 对齐；改那边必须同步改这里 */
const IP_MAX = 300;

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

/** 第 i 个测试手机号（够 300 个不重样，且都是合法号段） */
function nthPhone(i: number): string {
  return `13${800000000 + i}`;
}

/** 往限流流水里灌 n 条历史（模拟同一出口 IP 上别人已经发过的量） */
function seedIpEvents(db: Database, ip: string, n: number, when: Date): void {
  const ins = db.prepare('INSERT INTO ip_quota_events (ip, created_at) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(ip, toSql(when));
  })();
}

function ipEventCount(db: Database, ip: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM ip_quota_events WHERE ip = ?').get(ip) as { n: number }
  ).n;
}

/** 走完「发码 → 验码」把某个号码做成验证过的存量用户 */
async function makeExistingUser(db: Database, phone: string, now: Date): Promise<void> {
  const sent = await sendPhoneCode(db, { phone, ip: IP }, makeDeps(now).deps);
  expect(sent.ok, '前置失败：发码没走通').toBe(true);
  const verified = verifyPhoneCode(
    db,
    { phone, code: lastSmsCode(db, hashLookup(phone)) },
    { now },
  );
  expect(verified.ok, '前置失败：建号没走通').toBe(true);
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

  test('同一 IP 24h 内最多 300 次（换手机号也挡），第 301 次被拒', async () => {
    const db = makeTestDb();
    for (let i = 0; i < IP_MAX; i++) {
      const result = await sendPhoneCode(db, { phone: nthPhone(i), ip: IP }, makeDeps(T0).deps);
      expect(result.ok, `第 ${i + 1} 次不该被拒`).toBe(true);
    }
    const blocked = await sendPhoneCode(db, { phone: '13900139000', ip: IP }, makeDeps(T0).deps);
    expect(blocked).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });
    // 报错要说清撞的是哪堵墙、怎么绕开，否则用户只会以为产品坏了
    expect((blocked as { message: string }).message).toContain('出口 IP');
    expect((blocked as { message: string }).message).toContain('手机流量');

    // 换 IP 不受影响，说明确实是按 IP 分桶而不是全局桶
    const other = await sendPhoneCode(db, { phone: '13900139000', ip: '198.51.100.2' }, makeDeps(T0).deps);
    expect(other.ok).toBe(true);
  });

  test('配额状态在库里：换一个 db 句柄照样算数（进程重启不再清零）', async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-ipq-')),
      'lawer-test.sqlite',
    );
    try {
      const first = makeTestDb(file);
      // 真走两次发码路径，证明计数确实是发码时写进这张表的（不是测试自己造的数）
      await sendPhoneCode(first, { phone: nthPhone(0), ip: IP }, makeDeps(T0).deps);
      await sendPhoneCode(first, { phone: nthPhone(1), ip: IP }, makeDeps(T0).deps);
      expect(ipEventCount(first, IP)).toBe(2);
      seedIpEvents(first, IP, IP_MAX - 2, T0); // 同事们把剩下的额度用光
      first.close();

      // ← 这里等价于「进程重启」：句柄全新，进程内 Map 若还在就是空的
      const restarted = makeTestDb(file);
      expect(ipEventCount(restarted, IP)).toBe(IP_MAX);
      const blocked = await sendPhoneCode(
        restarted,
        { phone: nthPhone(2), ip: IP },
        makeDeps(T0).deps,
      );
      expect(blocked).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
      // 不是全盘拒绝：换个 IP 照样放行，说明拒的是配额而不是库坏了
      const other = await sendPhoneCode(
        restarted,
        { phone: nthPhone(3), ip: '198.51.100.5' },
        makeDeps(T0).deps,
      );
      expect(other.ok).toBe(true);
      restarted.close();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  test('判定窗是 24h：25 小时前的旧行不再算数', async () => {
    const db = makeTestDb();
    seedIpEvents(db, IP, IP_MAX, new Date(T0.getTime() - 25 * 3600 * 1000));
    const result = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    expect(result.ok).toBe(true);
  });

  test('写入时顺手清掉本 IP 超过 48h 的旧行，别的 IP 不受影响', async () => {
    const db = makeTestDb();
    const stale = new Date(T0.getTime() - 49 * 3600 * 1000);
    const kept = new Date(T0.getTime() - 47 * 3600 * 1000);
    seedIpEvents(db, IP, 1, stale);
    seedIpEvents(db, IP, 1, kept);
    seedIpEvents(db, '198.51.100.6', 1, stale);

    await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);

    // 本 IP：49h 前那行被清掉，47h 前那行还在保留窗内，外加刚记的这一次
    const rows = db
      .prepare('SELECT created_at FROM ip_quota_events WHERE ip = ? ORDER BY created_at')
      .all(IP) as { created_at: string }[];
    expect(rows.map((r) => r.created_at)).toEqual([toSql(kept), toSql(T0)]);
    // GC 只扫本 IP：别人的旧行不归这次写入管（全表清理是定时任务的活，这里没有定时任务）
    expect(ipEventCount(db, '198.51.100.6')).toBe(1);
  });

  test('存量用户登录不吃 IP 配额：额度满了老用户照样能登录，同 IP 的新号码仍被拒', async () => {
    const db = makeTestDb();
    await makeExistingUser(db, PHONE, T0);
    seedIpEvents(db, IP, IP_MAX, T0); // 同事们把这个出口 IP 的额度用光
    const before = ipEventCount(db, IP);

    const relogin = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(120)).deps);
    expect(relogin.ok).toBe(true);
    // 豁免＝既不判也不记：老用户登录不该反过来把额度吃掉
    expect(ipEventCount(db, IP)).toBe(before);

    // 豁免没有把墙拆了：同一 IP 上没见过的号码照旧被拒
    const stranger = await sendPhoneCode(
      db,
      { phone: '13900139000', ip: IP },
      makeDeps(at(120)).deps,
    );
    expect(stranger).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
  });

  test('豁免不空窗：存量用户仍受 60s 冷却与 10 次/日约束', async () => {
    const db = makeTestDb();
    await makeExistingUser(db, PHONE, T0); // 这一次已经算进该号码的日额度
    seedIpEvents(db, IP, IP_MAX, T0); // IP 这条从此不起作用，只剩号码维度挡着

    // 60s 冷却照旧
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(30)).deps)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
      retryAfter: 60,
    });

    // 日上限 10 次照旧：注册那次算 1，再放行 9 次，第 11 次被拒
    for (let i = 1; i < 10; i++) {
      expect(
        (await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(i * 120)).deps)).ok,
        `第 ${i + 1} 次不该被拒`,
      ).toBe(true);
    }
    expect(
      await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(10 * 120)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
  });

  test('限流对 created_at 的两种写法都算数（建表默认 datetime(\'now\') 是空格分隔，本模块写 ISO8601）', async () => {
    const db = makeTestDb();
    // 模拟一条走建表默认值落下的行："2026-08-19 10:00:00"，与 T0 同一时刻。
    // 裸字符串比较下它会排在 ISO 串之前而被当成"很久以前"，从而漏放一次发码。
    db.prepare(
      "INSERT INTO sms_codes (phone_hash, code, purpose, expires_at, created_at) VALUES (?, '123456', 'login', ?, '2026-08-19 10:00:00')",
    ).run(hashLookup(PHONE), at(300).toISOString());

    const blocked = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(30)).deps);
    expect(blocked).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED', retryAfter: 60 });
  });

  test('邮箱侧豁免：已验证过的邮箱重发不吃 IP 配额，绑新邮箱照旧计数', async () => {
    const db = makeTestDb();
    await makeExistingUser(db, PHONE, T0);
    const uid = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number })
      .id;
    const mail = 'a@b.com';

    // 注册阶段第一次绑邮箱：这时它还不是「验证过的存量邮箱」，照旧计入 IP 配额
    expect((await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(20)).deps)).ok).toBe(true);
    expect(
      verifyEmailCode(db, { userId: uid, email: mail, code: lastEmailCode(db, mail) }, { now: at(30) }).ok,
    ).toBe(true);

    seedIpEvents(db, IP, IP_MAX, T0); // 出口 IP 额度用光
    const before = ipEventCount(db, IP);

    // 验过的邮箱重发：放行且不记账
    expect((await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(200)).deps)).ok).toBe(true);
    expect(ipEventCount(db, IP)).toBe(before);

    // 换绑一个没验过的新邮箱：仍按新账号那条路算，配额满了就该拒
    expect(
      await sendEmailCode(db, { userId: uid, email: 'new@b.com', ip: IP }, makeDeps(at(260)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED' });
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

  // ===== F-204：发失败的那次不许占冷却与当日额度 =====
  //
  // 【为什么这条判据非有不可】用户看到的是「短信通道暂时发不出验证码…稍后再试」，
  // 照做立刻再点，得到的却是「发送太频繁，60 秒后再试」——两句话互相打架，
  // 而且上游抖动时会变成「报错→等 60 秒→再报错→再等 60 秒」的死循环。
  // 冷却与当日 10 次的**唯一账本就是 sms_codes / email_codes 的行**，所以判据直接钉行数：
  // 发失败留下了行 = 额度被吃掉了，与用户那侧看到的「被拦」是同一件事。

  function smsRowCount(db: Database, phone: string): number {
    return (
      db
        .prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone_hash = ?')
        .get(hashLookup(phone)) as { n: number }
    ).n;
  }

  /** 短信通道明确发不出去（走 classifySmsError 的兜底分支 SMS_UPSTREAM_ERROR） */
  function smsBoom(now: Date) {
    return {
      now,
      sendSms: async () => {
        throw new Error('短信网关连接超时');
      },
    };
  }

  test('🔴 短信没发出去 → 不占 60s 冷却也不占当日额度，立刻重发就能成（F-204）', async () => {
    const db = makeTestDb();

    const failed = await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(T0));
    expect(failed).toMatchObject({ ok: false, status: 502, errorCode: 'SMS_UPSTREAM_ERROR' });
    expect(smsRowCount(db, PHONE), '发失败还留着行 = 当日额度被白吃一次').toBe(0);

    // 一秒后立刻重发——这正是用户读完「稍后再试」后的第一个动作。挡住它的是 ≤5 秒防连击闸，
    // **不是 60 秒冷却**：错误码与 retry_after 都不同。这一句同时钉两件事——
    // 连点被拦住了（上游不会被无限重试打爆），而拦它的不是那次失败换来的冷却。
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(1)).deps)).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'SEND_TOO_FAST',
      retryAfter: 5,
    });

    // 过了短闸就放行——而且是 retry_after 说的第 5 秒**准点**就放行（边界钉死：闸用的是 >，
    // 改成 >= 会让按提示准点重试的人再吃一次 SEND_TOO_FAST）。离那次失败才 5 秒，远在 60 秒之内，
    // 说明冷却一点没被占
    const retry = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(5)).deps);
    expect(retry.ok, '发失败后过了短闸仍被拦 = F-204 复发').toBe(true);
    expect(smsRowCount(db, PHONE)).toBe(1);

    // 反向对照：这一次是真发出去了，60 秒冷却必须照常拦住下一次（且早于短闸报出来）
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(12)).deps)).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'RATE_LIMITED',
      retryAfter: 60,
    });
  });

  test('🔴 连着 10 次发失败也没吃掉当日 10 次额度，第 11 次仍发得出去（F-204）', async () => {
    const db = makeTestDb();
    // 每次隔 6 秒（跨过 ≤5 秒短闸）再点，并逐次断言错误码是 SMS_UPSTREAM_ERROR：
    // 这 10 次必须都真打到通道上才算数，被短闸挡掉的空转不占额度是废话，不是判据。
    for (let i = 0; i < 10; i++) {
      expect(
        await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(i * 6))),
        `第 ${i + 1} 次`,
      ).toMatchObject({ ok: false, status: 502, errorCode: 'SMS_UPSTREAM_ERROR' });
    }
    expect(smsRowCount(db, PHONE)).toBe(0);
    // 老逻辑走到这里当日额度已被失败发送吃光，这一次会是 RATE_LIMITED
    expect((await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(60)).deps)).ok).toBe(true);
  });

  test('🔴 邮件没发出去同样不占额度：邮箱侧与手机侧同一条规矩（F-204）', async () => {
    const db = makeTestDb();
    await makeExistingUser(db, PHONE, T0);
    const uid = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number })
      .id;
    const mail = 'f204@example.com';
    const rows = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ?').get(mail) as {
        n: number;
      }).n;

    const failed = await sendEmailCode(
      db,
      { userId: uid, email: mail, ip: IP },
      {
        now: at(20),
        sendEmail: async () => {
          throw new Error('SMTP 挂了');
        },
      },
    );
    expect(failed).toMatchObject({ ok: false, status: 502, errorCode: 'EMAIL_SEND_FAILED' });
    expect(rows(), '发失败还留着行 = 当日额度被白吃一次').toBe(0);

    // 与手机侧同一条：1 秒内重发撞的是 ≤5 秒短闸，不是那次失败换来的 60 秒冷却
    expect(
      await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(21)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'SEND_TOO_FAST', retryAfter: 5 });

    const retry = await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(26)).deps);
    expect(retry.ok, '发失败后过了短闸仍被拦 = F-204 复发').toBe(true);
    expect(rows()).toBe(1);

    // 反向对照：真发出去的那次照旧起 60 秒冷却
    expect(
      await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(32)).deps),
    ).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', retryAfter: 60 });
  });

  // 【为什么要按 error_code 再钉一次】上面三条钉的都是走兜底分支的失败
  // （SMS_UPSTREAM_ERROR / EMAIL_SEND_FAILED）。而工单里用户真正撞到的那次，是审查那台
  // 机器没配短信凭证：sendOtp 抛「阿里云短信凭证未配置」，classifySmsError 把它归到
  // SMS_CONFIG_ERROR(500)，跟兜底的 502 不是同一条分支。只钉 502 的话，「只在 502 时撤行」
  // 这种改法能活着通过全部测试，而复现工单的恰恰是 500 这一条路。
  test('🔴 凭证未配置（SMS_CONFIG_ERROR，工单复现的正是这条）也不占冷却与额度（F-204）', async () => {
    const db = makeTestDb();

    const failed = await sendPhoneCode(
      db,
      { phone: PHONE, ip: IP },
      {
        now: T0,
        sendSms: async () => {
          throw new Error('阿里云短信凭证未配置');
        },
      },
    );
    expect(failed).toMatchObject({ ok: false, status: 500, errorCode: 'SMS_CONFIG_ERROR' });
    expect(smsRowCount(db, PHONE), '发失败还留着行 = 当日额度被白吃一次').toBe(0);

    // 1 秒内重发撞的是 ≤5 秒短闸（错误码不同于 60 秒冷却），过了短闸就放行
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(1)).deps)).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'SEND_TOO_FAST',
      retryAfter: 5,
    });
    expect(
      (await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(6)).deps)).ok,
      '发失败后过了短闸仍被拦 = F-204 复发',
    ).toBe(true);
  });

  // 【撤行必须是外科手术】撤行撤宽了是反方向的同一个 bug：用户之前真收到过的那几条
  // 短信/邮件本来就该占掉当日额度，被一次失败连坐抹掉，等于把限流白送出去。
  // 上面几条判据里库表始终只有 0 或 1 行，撤宽撤窄看不出区别，所以这里先垫上几条真发成功的行。
  test('🔴 失败撤行只撤自己那一行，之前成功发出去的额度不受连坐（F-204）', async () => {
    const db = makeTestDb();

    // 手机侧：按 60s 冷却的节奏真发出去 3 次，这 3 次是实打实占额度的
    for (let i = 0; i < 3; i++) {
      expect(
        (await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(i * 60)).deps)).ok,
        `前置失败：第 ${i + 1} 次没发出去`,
      ).toBe(true);
    }
    expect(smsRowCount(db, PHONE)).toBe(3);

    expect((await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(180)))).ok).toBe(false);
    expect(smsRowCount(db, PHONE), '一次发失败把之前成功的行也抹了 = 当日额度被凭空退回').toBe(3);

    // 邮箱侧同一条规矩（历史上 otp.ts 手机侧/邮箱侧同名代码漏改过，两侧各钉一次）
    await makeExistingUser(db, nthPhone(204), T0);
    const uid = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number })
      .id;
    const mail = 'f204-scope@example.com';
    const mailRows = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ?').get(mail) as {
        n: number;
      }).n;

    for (let i = 0; i < 3; i++) {
      expect(
        (await sendEmailCode(db, { userId: uid, email: mail, ip: IP }, makeDeps(at(i * 60)).deps))
          .ok,
        `前置失败：邮箱第 ${i + 1} 次没发出去`,
      ).toBe(true);
    }
    expect(mailRows()).toBe(3);

    const mailFailed = await sendEmailCode(
      db,
      { userId: uid, email: mail, ip: IP },
      {
        now: at(180),
        sendEmail: async () => {
          throw new Error('SMTP 挂了');
        },
      },
    );
    expect(mailFailed.ok).toBe(false);
    expect(mailRows(), '邮箱侧一次发失败把之前成功的行也抹了').toBe(3);
  });

  // 【9 成功 + 1 失败 + 第 10 次成功，第 11 次必须被拒】上一条用 3 行垫底钉「撤宽了」，
  // 这一条把垫底铺满到当日上限的边界上：撤行只要多撤一行，当日 10 次就凭空多出一次，
  // 而多出来的那一次在 3 行的规模下看不出来（3 与 2 都远离上限，两种实现全绿）。
  // 反过来也钉住了「失败不占额度」不是靠少算一次蒙对的：第 10 次仍要发得出去。
  test('🔴 9 次成功 + 1 次失败 + 第 10 次成功 → 第 11 次仍被当日上限拒（F-204 / R1）', async () => {
    const db = makeTestDb();

    // 按 60s 冷却的节奏真发 9 次，每一次都实打实占掉一格当日额度
    for (let i = 0; i < 9; i++) {
      expect(
        (await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(i * 60)).deps)).ok,
        `前置失败：第 ${i + 1} 次没发出去`,
      ).toBe(true);
    }
    expect(smsRowCount(db, PHONE)).toBe(9);

    // 第 10 次通道报错：撤掉自己那一行，前面 9 行一行不许少
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(540)))).toMatchObject({
      ok: false,
      status: 502,
      errorCode: 'SMS_UPSTREAM_ERROR',
    });
    expect(smsRowCount(db, PHONE), '失败连坐抹掉了之前成功的行 = 当日额度被凭空退回').toBe(9);

    // 那次失败没占额度，所以第 10 格还空着（隔过 ≤5 秒短闸再点）
    expect(
      (await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(546)).deps)).ok,
      '失败占掉了当日额度 = F-204 复发',
    ).toBe(true);
    expect(smsRowCount(db, PHONE)).toBe(10);

    // 而第 11 次必须撞上当日上限：额度是被 10 次**成功**发送吃满的，不是被那次失败吃的
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(at(606)).deps)).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'RATE_LIMITED',
    });
  });

  // ===== ≤5 秒防连击闸：F-204 撤行后留下的那个缺口 =====
  //
  // 【口径未裁决】下面两条判据钉的是 ADR-003 的 A 案。工单原判据写的是「失败后**立即**重发放行」，
  // A 案把它改写成了「5 秒后放行」——这一改写尚未获经理裁决，见 docs/adr/003。
  //
  // 【为什么非有不可】撤行让失败的发送不占 60s 冷却，而 IP 那条计数对存量用户登录整条豁免。
  // 两者叠起来，一个老用户在通道持续报错时**一点节流都没有**——按住重发就是对上游的无限重试。
  // 判据钉三件事：拦得住（1 秒内重发被拒）、拦的不是 60 秒那道闸（错误码与 retry_after 都不同）、
  // 5 秒后一定放行（短闸误设成 60 秒就会红在这一句上）。

  test('🔴 存量用户 + 通道持续报错：1 秒内重发被 5 秒闸拦，5 秒后放行且仍回通道错误', async () => {
    const db = makeTestDb();
    await makeExistingUser(db, PHONE, T0); // 这条路径 knownUser=true，IP 计数整条豁免

    const first = await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(120)));
    expect(first).toMatchObject({ ok: false, status: 502, errorCode: 'SMS_UPSTREAM_ERROR' });

    // 1 秒后按住再点：被短闸拦下，且这一次根本没打到通道上（sms 假实现一次都没被调）
    const boomAgain = { now: at(121), sendSms: vi.fn(async () => { throw new Error('短信网关连接超时'); }) };
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, boomAgain)).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'SEND_TOO_FAST',
      retryAfter: 5,
    });
    expect(boomAgain.sendSms, '被短闸拦下的请求仍然打到了上游 = 节流没生效').not.toHaveBeenCalled();
    // 拦它的不是 60 秒冷却：文案必须分得开，否则用户被告知要等 60 秒（实际只要 5 秒）
    const blocked = await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(122)));
    expect((blocked as { message: string }).message).not.toContain('60 秒');

    // 连点不会把窗口往后推：4 秒处又点一次，6 秒处照样放行（窗口从上一次真发起算）
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(124)))).toMatchObject({
      ok: false,
      errorCode: 'SEND_TOO_FAST',
    });
    // 5 秒后放行：闸开了，但通道还是坏的——放行 ≠ 把错误吞掉
    expect(await sendPhoneCode(db, { phone: PHONE, ip: IP }, smsBoom(at(126)))).toMatchObject({
      ok: false,
      status: 502,
      errorCode: 'SMS_UPSTREAM_ERROR',
    });
    expect(smsRowCount(db, PHONE), '这一串连点一行额度都不该留下').toBe(1); // 只剩注册那次
  });

  test('🔴 邮箱侧同一条短闸：两侧不许只做一半（otp.ts 手机/邮箱同名代码漏改过）', async () => {
    const db = makeTestDb();
    const mail = 'burst@example.com';
    const boom = (now: Date) => ({
      now,
      sendEmail: async () => {
        throw new Error('SMTP 挂了');
      },
    });

    expect(await sendEmailRegisterCode(db, { email: mail, ip: IP }, boom(T0))).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SEND_FAILED',
    });
    expect(await sendEmailRegisterCode(db, { email: mail, ip: IP }, boom(at(1)))).toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'SEND_TOO_FAST',
      retryAfter: 5,
    });
    // 5 秒后放行，且仍回通道错误
    expect(await sendEmailRegisterCode(db, { email: mail, ip: IP }, boom(at(6)))).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SEND_FAILED',
    });
    // 短闸按邮箱分桶：另一个地址不受连坐
    expect(
      await sendEmailRegisterCode(db, { email: 'other@example.com', ip: IP }, boom(at(6))),
    ).toMatchObject({ ok: false, errorCode: 'EMAIL_SEND_FAILED' });
  });

  // 【先插行后发送不是顺手写的，那一行在发送期间就是防连击闸】撤行只发生在通道确认发不出去
  // 之后，所以闸只存活「一次通道调用」那么久。要是图省事改成「发成功了再插行」，失败不占额度
  // 这件事照样成立、上面所有判据全绿，但发送途中同一号码再点就会并发打第二条短信出去。
  test('🔴 第一条还在通道里飞时，同号再点会被挡住（发送期间的防连击闸，F-204）', async () => {
    const db = makeTestDb();

    let release!: () => void;
    const stillInChannel = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inflight = sendPhoneCode(
      db,
      { phone: PHONE, ip: IP },
      {
        now: T0,
        sendSms: async () => {
          await stillInChannel;
        },
      },
    );

    // 此刻第一条还卡在通道里，用户手一抖又点了一次
    const second = await sendPhoneCode(db, { phone: PHONE, ip: IP }, makeDeps(T0).deps);
    expect(second, '发送期间同号再点没被挡 = 一次点击并发打两条短信出去').toMatchObject({
      ok: false,
      status: 429,
      errorCode: 'RATE_LIMITED',
    });

    release();
    expect((await inflight).ok, '闸放行后第一条本身要正常成功').toBe(true);
    expect(smsRowCount(db, PHONE), '两次点击只该留下一行').toBe(1);
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
    expect(row).toEqual({ email: 'user@example.com', email_verified_at: toSql(at(30)) });

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
    expect(neutral.email.mock.calls[0][1].subject).not.toContain('土八鼠');

    db.prepare('UPDATE users SET notify_verbose = 1 WHERE id = ?').run(uid);
    const verbose = makeDeps(at(200));
    await sendEmailCode(db, { userId: uid, email: 'a@b.com', ip: IP }, verbose.deps);
    expect(verbose.email.mock.calls[0][1].subject).toContain('土八鼠');
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
