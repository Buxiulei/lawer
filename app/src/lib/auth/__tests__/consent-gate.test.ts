// app/src/lib/auth/__tests__/consent-gate.test.ts
// 注册/首次登录那道同意闸（协议 一.3、二.6、五.5（2）/ 附一 #1、#2、#6）。
//
// 【为什么判据挂在路由上而不是 lib 函数上】"完成注册"这件事发生在**发出登录态**的那一刻。
// 只测 registrationConsentFailure 这个纯函数的形态是：函数判得好好的，而三条发登录态的
// 路由里有一条忘了调它——两边都绿，那条路上谁都不用勾就能建号。所以这里逐条走真路由。
//
// 【三臂，不是两臂】
//  · 没勾 ⇒ 400 CONSENT_REQUIRED，**不发登录态、不建号、验证码不被消耗**；
//  · 勾了 ⇒ 照常发登录态，且 terms/adult 两行都落进台账；
//  · 存量用户 ⇒ 补绑那一步不再问第二遍（台账里已经有了就放行）。
//
// 【境外那一位是可选项，单独一组】主理人 2026-09-07 口径：注册页在总同意之外**单独**
// 一个勾选框，默认未勾，**不勾照样注册**。它的两臂是"勾了就开、不勾就不开"，
// 而不是"不勾就拦住"——把它测成前置条件，等于把这条判据写反了。
//
// 【变异矩阵】2026-09-07 逐条实跑（结果照抄在各 describe 的抬头上）。
//
// 【本文件整组跑在旗打开的那一臂】协议生效旗 LAWER_TERMS_LIVE 默认关，关着时这道闸
// 整个不在（经理裁决 2026-09-07：协议里还有占位，不能拿去当注册的前置条件）。
// 这一组要判的是**协议生效之后**的闸，所以先把旗打开；旗关着那一臂另有一组
// （lib/auth/__tests__/terms-live-flag.test.ts）。不显式设旗的形态是：
// 本组随环境变量的默认值一起变绿变红，而它自己一个字都不提这件事。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { TERMS_LIVE_ENV } from '@/lib/auth/consent';
import { CONSENT_KINDS } from '@/lib/consent';
import { consentedKinds, hasConsent } from '@/lib/db/consents';
import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';

type Handler = (req: Request) => Promise<Response>;
let smsVerify: Handler;
let emailRegisterVerify: Handler;
let db: Database;

/** 两个必勾位都勾上（境外那一位另测） */
const AGREED = { agree_terms: true, agree_adult: true };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/auth/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env[TERMS_LIVE_ENV] = '1';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-consent-gate-${crypto.randomUUID()}.db`);
  smsVerify = (await import('@/app/api/v1/auth/sms/verify/route')).POST;
  emailRegisterVerify = (await import('@/app/api/v1/auth/email/register/verify/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

let phone: string;
/** 与产线同一把带密钥摘要。自己再算一遍裸 sha256 的形态是：行插进去了，验码时找不到。 */
let hashLookup: (v: string) => string;

beforeAll(async () => {
  hashLookup = (await import('@/lib/crypto')).hashLookup;
});

beforeEach(() => {
  // 每个用例换一个没用过的手机号：本组测的是"建号那一次"，
  // 共用号会让第二个用例悄悄走成"老用户登录"——那是另一条路径。
  phone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
});

const hashOf = (target: string): string => hashLookup(target);

/** 直接把一条有效验证码落库（发送通道不是本组要测的东西） */
function sendSmsCode(target: string): string {
  const code = '123456';
  store.insertSmsCode(db, {
    phoneHash: hashOf(target),
    code,
    expiresAt: toSql(new Date(Date.now() + 5 * 60 * 1000)),
    createdAt: toSql(new Date()),
  });
  return code;
}

const userIdByPhone = (target: string): number | undefined =>
  store.findUserByPhoneHash(db, hashOf(target))?.id;

const smsRowCount = (target: string): { used: number; attempts: number } => {
  const row = store.latestSmsCode(db, hashOf(target))!;
  return { used: Number(row.used), attempts: Number(row.attempts) };
};

/* ───────────────────────── 必勾的两位 ───────────────────────── */
//
// 【变异臂】2026-09-07 实跑，本文件 11 例：
//  · G-1 sms/verify 拿到闸的失败却不返回                 ⇒ 5 失败 / 6 通过。
//  · G-2 registrationConsentFailure 只判 terms 不判 adult ⇒ 1 失败 / 10 通过。
//  · G-3 recordRegistrationConsent 不落 adult 那一行      ⇒ 3 失败 / 8 通过。
describe('必勾的两位：没勾就建不了号', () => {
  test('一个都没勾 ⇒ 400 CONSENT_REQUIRED，不发登录态、不建号', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe('CONSENT_REQUIRED');
    expect(body.token, '闸没过就一个 token 都不许发').toBeUndefined();
    expect(userIdByPhone(phone), '闸没过就不许建号').toBeUndefined();
  });

  test('没勾时**验证码不被消耗**（下一次带上勾选还能用同一串码）', async () => {
    // 【为什么这条要单独设防】先验码再判同意的形态是：用户忘了勾一个框，
    // 那串码就作废了，他得重新等一分钟——而错误提示说的是"请勾选后再提交"，
    // 照做一遍却告诉他验证码错误。两条信息互相矛盾，而两边都"正常工作"。
    const code = sendSmsCode(phone);
    await smsVerify(post({ phone, code }));
    expect(smsRowCount(phone), '没勾选不该消耗掉用户手上那串码').toEqual({ used: 0, attempts: 0 });

    const ok = await smsVerify(post({ phone, code, ...AGREED }));
    expect(ok.status, '补勾之后同一串码要还能用').toBe(200);
  });

  test('只勾了协议、没勾年龄 ⇒ 仍然拒，且提示点名缺的是哪一个', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, agree_terms: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe('CONSENT_REQUIRED');
    // 自述三段式的第一段：缺什么。只说"请勾选"的形态是用户盯着两个框不知道差哪个
    expect(String(body.message)).toContain('年满十八周岁');
    expect(String(body.message), '已经勾了的那个不该再被点名').not.toContain('《用户服务协议》');
  });

  test('字符串 "true" 与数字 1 都不算勾过（只认布尔真）', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, agree_terms: 'true', agree_adult: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('CONSENT_REQUIRED');
  });

  test('两个都勾了 ⇒ 发登录态，且 terms/adult 两行都落进台账', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, ...AGREED }));
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeTruthy();

    const uid = userIdByPhone(phone)!;
    expect(consentedKinds(db, uid).sort()).toEqual([CONSENT_KINDS.adult, CONSENT_KINDS.terms].sort());
  });

  test('每次登录都再勾一次，台账里**不会长出重复行**（唯一索引兜底）', async () => {
    const code1 = sendSmsCode(phone);
    await smsVerify(post({ phone, code: code1, ...AGREED }));
    const uid = userIdByPhone(phone)!;

    const code2 = sendSmsCode(phone);
    await smsVerify(post({ phone, code: code2, ...AGREED }));

    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM consents WHERE user_id=? AND kind='terms'").get(uid) as {
        n: number;
      }
    ).n;
    // 逐次落行的形态是台账里全是重复行，而"他第一次是什么时候同意的"要翻到最底下才找得到
    expect(n).toBe(1);
  });

  test('邮箱注册那条路同样受闸（三条发登录态的路由，一条都不能漏）', async () => {
    const email = `a${crypto.randomUUID().slice(0, 8)}@example.com`;
    store.insertEmailCode(db, {
      email,
      code: '654321',
      purpose: store.EMAIL_PURPOSE.register,
      expiresAt: toSql(new Date(Date.now() + 5 * 60 * 1000)),
      createdAt: toSql(new Date()),
    });

    const denied = await emailRegisterVerify(post({ email, code: '654321' }));
    expect(denied.status).toBe(400);
    expect((await denied.json()).error_code).toBe('CONSENT_REQUIRED');
    expect(store.findUserByEmail(db, email), '闸没过就不许建号').toBeUndefined();

    const ok = await emailRegisterVerify(post({ email, code: '654321', ...AGREED }));
    expect(ok.status).toBe(200);
    const uid = store.findUserByEmail(db, email)!.id;
    expect(hasConsent(db, uid, CONSENT_KINDS.terms)).toBe(true);
    expect(hasConsent(db, uid, CONSENT_KINDS.adult)).toBe(true);
  });
});

/* ───────────────── 境外那一位：可选，且只往"开"的方向走 ───────────────── */
//
// 【变异臂】2026-09-07 实跑，本文件 11 例：
//  · G-4 把 agree_overseas 加进闸的判定（＝这一位变成必勾）⇒ 6 失败 / 5 通过。
//  · G-5 只落台账、不置 users.overseas_models             ⇒ 2 失败 / 9 通过。
//  · G-6 没勾时把开关按勾选位覆写（＝顺手"撤回"）          ⇒ 1 失败 / 10 通过。
describe('境外模型那一位：单独一个框，可选，默认未勾', () => {
  test('不勾照样注册成功，且开关是关的、台账里没有 overseas 那一行', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, ...AGREED }));
    expect(res.status, '境外这一位不勾**不许**影响注册').toBe(200);

    const uid = userIdByPhone(phone)!;
    expect(store.getModelPreferences(db, uid).overseasModels, '未问即未同意，默认关').toBe(false);
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas)).toBe(false);
  });

  test('勾了 ⇒ 台账落一行 overseas，**并且**开关真的置上了', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, ...AGREED, agree_overseas: true }));
    expect(res.status).toBe(200);

    const uid = userIdByPhone(phone)!;
    // 两样都要：只写台账的形态是他勾了框而路由照样走境内（他以为开了）；
    // 只写开关的形态是日后证明不了他同意过。
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas), '台账要记下"他同意过"').toBe(true);
    expect(store.getModelPreferences(db, uid).overseasModels, '开关要记下"现在生效的是什么"').toBe(true);
  });

  test('已经开着的人，下次登录**不勾也不会被静默关掉**（撤回只走设置页）', async () => {
    // 注册页那个框默认未勾。每次登录都按它覆写的形态是：一个在设置页开过境外模型的人，
    // 下次登录后开关变了样，而他没做任何撤回的动作，两边都不报错。
    const code1 = sendSmsCode(phone);
    await smsVerify(post({ phone, code: code1, ...AGREED, agree_overseas: true }));
    const uid = userIdByPhone(phone)!;
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(true);

    const code2 = sendSmsCode(phone);
    await smsVerify(post({ phone, code: code2, ...AGREED })); // 这次没勾
    expect(store.getModelPreferences(db, uid).overseasModels, '不勾 ≠ 撤回').toBe(true);
  });
});

/* ───────────────── 存量用户：首次登录补勾，补完不再问 ───────────────── */
describe('存量用户补勾', () => {
  test('从没勾过的老账号，下一次登录必须补勾（补完台账才有行）', async () => {
    // 存量账号：直接建号，不经同意闸——模拟本票上线之前就存在的用户
    const legacy = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const uid = store.insertUser(db, {
      phoneEnc: 'enc',
      phoneHash: hashOf(legacy),
      verifiedAt: toSql(new Date()),
    });
    expect(consentedKinds(db, uid), '前提自检：这个人从没同意过').toEqual([]);

    const code = sendSmsCode(legacy);
    const denied = await smsVerify(post({ phone: legacy, code }));
    expect(denied.status, '老用户同样要补勾——只在建号那次要求的形态是他永远走不到那一次').toBe(400);
    expect((await denied.json()).error_code).toBe('CONSENT_REQUIRED');

    const ok = await smsVerify(post({ phone: legacy, code, ...AGREED }));
    expect(ok.status).toBe(200);
    expect(consentedKinds(db, uid).sort()).toEqual([CONSENT_KINDS.adult, CONSENT_KINDS.terms].sort());
  });
});

/* ───────────── 落台账只按"这次勾没勾"，不按"闸放没放行" ───────────── */
//
// 【守的是哪种失效】闸有一条旁路：补绑那一路（这个账号此前勾过）不带勾选位也能过。
// recordRegistrationConsent 无条件落行的形态是——协议改版之后，这个人凭旧版的同意
// 过了闸，我们却给他记上一行**新版**的同意，而他从没读过新版那份文本。
// 台账要回答的正是"他当时同意的是哪一版"，编出来的那一行让这个问题永远答不对，
// 而没有任何一处会报错（经理裁决 2026-09-07 C1 minor 第一条）。
//
// 【变异臂】2026-09-07 实跑，本组 4 例：
//  · G-7 recordRegistrationConsent 恢复成无条件落 terms/adult ⇒ 3 失败 / 1 通过。
describe('落台账只认这次请求里的勾选位', () => {
  let recordRegistrationConsent: typeof import('@/lib/auth/consent').recordRegistrationConsent;
  let recordConsent: typeof import('@/lib/db/consents').recordConsent;

  beforeAll(async () => {
    recordRegistrationConsent = (await import('@/lib/auth/consent')).recordRegistrationConsent;
    recordConsent = (await import('@/lib/db/consents')).recordConsent;
  });

  /** 建一个不经同意闸的账号（模拟存量用户 / 补绑那一路拿到的 uid） */
  function newUser(): number {
    const target = `137${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    return store.insertUser(db, {
      phoneEnc: 'enc',
      phoneHash: hashOf(target),
      verifiedAt: toSql(new Date()),
    });
  }

  const rowsOf = (uid: number): { kind: string; version: string }[] =>
    db
      .prepare('SELECT kind, version FROM consents WHERE user_id=? ORDER BY kind, version')
      .all(uid) as { kind: string; version: string }[];

  test('一位都没勾 ⇒ 一行都不落（变异：改回无条件落行 → 本条红）', () => {
    const uid = newUser();
    recordRegistrationConsent(db, uid, {}, null);
    expect(rowsOf(uid), '没勾却记了一次同意').toEqual([]);
  });

  test('只勾了协议 ⇒ 只落 terms 那一行，adult 不跟着来', () => {
    const uid = newUser();
    recordRegistrationConsent(db, uid, { agree_terms: true }, null);
    expect(rowsOf(uid).map((r) => r.kind)).toEqual([CONSENT_KINDS.terms]);
  });

  test('两位都勾 ⇒ 两行都在（正对照：别把闸改成恒不落行也全绿）', () => {
    const uid = newUser();
    recordRegistrationConsent(db, uid, { agree_terms: true, agree_adult: true }, null);
    expect(rowsOf(uid).map((r) => r.kind).sort()).toEqual(
      [CONSENT_KINDS.adult, CONSENT_KINDS.terms].sort(),
    );
  });

  test('协议改版后，凭旧版同意过闸的人**不会被记上新版的同意**', () => {
    const uid = newUser();
    // 他当年同意的是 v0.1
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.terms, version: 'v0.1' });
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.adult, version: 'v0.1' });
    // 今天带 token 补绑邮箱：闸看的是 hasRegistrationConsent（不比对版本），放行；
    // 请求体里一位勾选都没有——页面上根本没再问过他。
    recordRegistrationConsent(db, uid, {}, null);
    expect(
      rowsOf(uid).map((r) => r.version),
      '他从没读过当前这一版，台账里却多了一行说他同意过',
    ).toEqual(['v0.1', 'v0.1']);
  });
});
