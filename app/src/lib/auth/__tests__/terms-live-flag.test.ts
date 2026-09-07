// app/src/lib/auth/__tests__/terms-live-flag.test.ts
// 协议生效旗 LAWER_TERMS_LIVE 的**旗关那一臂**（经理裁决 2026-09-07）。
//
// 【为什么要这一组】旗打开那一臂已经有一整套判据（consent-gate / consent-routes /
// lifecycle-consents，三组都在文件头写明自己跑在开臂）。只有开臂的形态是：
// 旗关着时的行为**一条判据都没有**——而生产上现在跑的正是关着的那一臂。
// 于是"协议没生效时不拦人、不落行、不出境"这三句承诺，只写在注释里。
//
// 【三条承诺，各自能单独坏，且坏了都不报错】
//  · 闸还在 ⇒ 页面上没有框（LoginForm 那边旗关就不渲染），而服务端仍要求勾选：
//    所有人都注册不了，错误文案指着一处空白；
//  · 闸放行但**照旧落行** ⇒ 库里攒下一批指向一份尚未发布文本的同意记录，
//    协议真发布那天这批人不会被要求再勾一次（hasRegistrationConsent 认得那些行）；
//  · 出境闸照旧只看「同意 ∧ 开关」 ⇒ 老用户此前开过的开关仍然生效，
//    对话继续交给境外接收方，而那页告知还有占位。
//
// 【为什么每条都配开臂正对照】"关着时不落行"有两种做法都能变绿：真按旗判，或者干脆谁都不落。
// 少了正对照，把 recordRegistrationConsent 改成空函数，本组照样全绿。
//
// 【变异矩阵】见文件末尾。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CONSENT_KINDS } from '@/lib/consent';
import { consentedKinds, recordConsent } from '@/lib/db/consents';
import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';
import { route, type Plan, type TaskClass } from '@/lib/llm';

import { TERMS_LIVE_ENV, overseasModelsAllowed, termsLive } from '../consent';

type Handler = (req: Request) => Promise<Response>;
let smsVerify: Handler;
let preferencesPost: Handler;
let db: Database;
let signToken: (uid: number) => string;
let hashLookup: (v: string) => string;

/** 三个勾选位全带上——**关臂里带不带都不该有区别**，这是本组最容易写漏的一半 */
const ALL_TICKED = { agree_terms: true, agree_adult: true, agree_overseas: true };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/auth/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // 本组自己管这个变量：不设的形态是它跟着同一个 worker 里上一个文件留下的值走，
  // 而那个文件（consent-gate 等）正好把旗打开——于是"关臂"判据在开臂上跑，还全绿。
  delete process.env[TERMS_LIVE_ENV];
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-terms-flag-${crypto.randomUUID()}.db`);
  smsVerify = (await import('@/app/api/v1/auth/sms/verify/route')).POST;
  preferencesPost = (await import('@/app/api/v1/me/preferences/route')).POST;
  signToken = (await import('@/lib/auth')).signToken;
  hashLookup = (await import('@/lib/crypto')).hashLookup;
  db = (await import('@/lib/db/client')).getDb();
});

afterAll(() => {
  delete process.env[TERMS_LIVE_ENV];
});

let phone: string;
beforeEach(() => {
  delete process.env[TERMS_LIVE_ENV];
  phone = `137${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
});

/** 直接把一条有效验证码落库（发送通道不是本组要测的东西） */
function sendSmsCode(target: string): string {
  const code = '123456';
  store.insertSmsCode(db, {
    phoneHash: hashLookup(target),
    code,
    expiresAt: toSql(new Date(Date.now() + 5 * 60 * 1000)),
    createdAt: toSql(new Date()),
  });
  return code;
}

const userIdByPhone = (target: string): number | undefined =>
  store.findUserByPhoneHash(db, hashLookup(target))?.id;

/* ───────────────────────── 旗本身怎么读 ───────────────────────── */

describe('termsLive：默认关，只认 1 / true', () => {
  test('没设 ⇒ 关（生产此刻就是这一臂）', () => {
    delete process.env[TERMS_LIVE_ENV];
    expect(termsLive()).toBe(false);
  });

  test('空串与只有空白 ⇒ 关（漏配的 app.env 里最常见的两种写法）', () => {
    for (const v of ['', '   ']) {
      process.env[TERMS_LIVE_ENV] = v;
      expect(termsLive(), `「${v}」被当成了开`).toBe(false);
    }
  });

  test('1 / true / TRUE / 带空白的 true ⇒ 开', () => {
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      process.env[TERMS_LIVE_ENV] = v;
      expect(termsLive(), `「${v}」没被当成开`).toBe(true);
    }
  });

  test('认不出的值一律当关（打错字的代价只能是"没开"，不能是"拿没写完的协议取同意"）', () => {
    for (const v of ['0', 'no', 'flase', 'yes', 'on']) {
      process.env[TERMS_LIVE_ENV] = v;
      expect(termsLive(), `「${v}」被当成了开`).toBe(false);
    }
  });

  test('每次现读，不进程级缓存（改完重启即生效，而不是停在启动那一刻）', () => {
    process.env[TERMS_LIVE_ENV] = '1';
    expect(termsLive()).toBe(true);
    delete process.env[TERMS_LIVE_ENV];
    expect(termsLive()).toBe(false);
  });
});

/* ───────────────────── 关臂：注册闸不拦、台账不落行 ───────────────────── */
//
// 【变异臂】2026-09-07 实跑，见文件末尾 M-1 / M-2。
describe('旗关：注册那道闸整个不在', () => {
  test('一个勾选位都不带 ⇒ 200 发登录态、建号，且台账一行都没有', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code }));
    const body = await res.json();

    expect(res.status, '协议没生效却仍然拦人：页面上根本没有可勾的框').toBe(200);
    expect(typeof body.token, '没发登录态').toBe('string');
    const uid = userIdByPhone(phone);
    expect(uid, '号没建成').toBeGreaterThan(0);
    expect(consentedKinds(db, uid!), '协议没生效就落了同意行').toEqual([]);
  });

  test('三个勾选位全带上 ⇒ 照样一行都不落（前端老版本仍然会带，服务端不能据此落行）', async () => {
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, ...ALL_TICKED }));
    expect(res.status).toBe(200);

    const uid = userIdByPhone(phone)!;
    expect(
      consentedKinds(db, uid),
      '请求里带了勾选位就落行 = 台账里出现了一份还没发布的协议的同意记录',
    ).toEqual([]);
    expect(
      store.getModelPreferences(db, uid).overseasModels,
      '境外开关被一个还没生效的勾选位打开了',
    ).toBe(false);
  });

  test('正对照：同一条请求在开臂上照旧落两行、开关照旧置上（别把闸改成恒不落行）', async () => {
    process.env[TERMS_LIVE_ENV] = '1';
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code, ...ALL_TICKED }));
    expect(res.status).toBe(200);

    const uid = userIdByPhone(phone)!;
    expect(consentedKinds(db, uid).sort()).toEqual(
      [CONSENT_KINDS.adult, CONSENT_KINDS.overseas, CONSENT_KINDS.terms].sort(),
    );
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(true);
  });

  test('正对照：开臂上不带勾选位仍然 400（关臂那个 200 不是因为闸本来就坏了）', async () => {
    process.env[TERMS_LIVE_ENV] = '1';
    const code = sendSmsCode(phone);
    const res = await smsVerify(post({ phone, code }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('CONSENT_REQUIRED');
    expect(userIdByPhone(phone), '被拦下却仍然建了号').toBeUndefined();
  });
});

/* ───────────────────── 关臂：一律不出境（假中转零命中）───────────────────── */
//
// 【为什么用"假中转"而不是断言 overseasModelsAllowed 回 false】那个函数回什么是**手段**，
// 用户的对话有没有出境才是**结论**。只断言函数的形态是：某天有人给 route() 加了第二条
// 取模型的路，函数照旧回 false，而那条新路照样走中转——判据全绿。
// 所以这里把「四家全部可用」和「只有中转可用」两种环境都跑一遍：
// 前者要求**一次都没落在中转上**，后者要求**宁可抛错也不出境**。
describe('旗关：overseasModelsAllowed 恒 false，路由一次都不落在中转上', () => {
  const TASK_CLASSES: TaskClass[] = ['critical', 'standard', 'bulk'];
  const PLANS: Plan[] = ['entry', 'standard', 'pro'];
  const allAvailable = () => true;
  const onlyRelay = (p: string) => p === 'relay';

  /** 一个「同意过 + 开关也开着」的账号——开臂上他是允许出境的那种人 */
  function grantedUser(): number {
    const uid = Number(
      db
        .prepare('INSERT INTO users (phone_hash, auth_status) VALUES (?, ?)')
        .run(`hash-${crypto.randomUUID()}`, '未认证').lastInsertRowid,
    );
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.overseas });
    store.setModelPreferences(db, uid, { overseasModels: true });
    return uid;
  }

  test('同意齐、开关开着，旗关着仍然判定为不许出境', () => {
    const uid = grantedUser();
    expect(overseasModelsAllowed(db, uid)).toBe(false);
    process.env[TERMS_LIVE_ENV] = '1';
    expect(overseasModelsAllowed(db, uid), '正对照：开臂上这个人是允许出境的').toBe(true);
  });

  test('九个档位逐个跑：假中转全程零命中（变异：把旗那一支删掉 → 本条红）', () => {
    const uid = grantedUser();
    const hits: string[] = [];
    for (const taskClass of TASK_CLASSES) {
      for (const plan of PLANS) {
        const r = route(taskClass, plan, {
          isAvailable: allAvailable,
          overseasAllowed: overseasModelsAllowed(db, uid),
        });
        if (r.provider === 'relay') hits.push(`${taskClass}/${plan}`);
      }
    }
    expect(hits, `协议没生效却把这几档交给了中转：${hits.join('、')}`).toEqual([]);
  });

  test('正对照：开臂上同一个人、同一套档位，中转是**有命中**的（量具不是恒回零）', () => {
    const uid = grantedUser();
    process.env[TERMS_LIVE_ENV] = '1';
    const hits: string[] = [];
    for (const taskClass of TASK_CLASSES) {
      for (const plan of PLANS) {
        const r = route(taskClass, plan, {
          isAvailable: allAvailable,
          overseasAllowed: overseasModelsAllowed(db, uid),
        });
        if (r.provider === 'relay') hits.push(`${taskClass}/${plan}`);
      }
    }
    expect(hits.length, '开臂上一档都没走中转 = 上一条的"零命中"根本不说明问题').toBeGreaterThan(0);
  });

  test('只有中转可用时**抛错而不是偷偷出境**（旗关着的人一样受这条保护）', () => {
    const uid = grantedUser();
    expect(() =>
      route('critical', 'pro', {
        isAvailable: onlyRelay,
        overseasAllowed: overseasModelsAllowed(db, uid),
      }),
    ).toThrow(/没有「境外模型处理」的有效同意/);
  });
});

/* ───────────────────── 关臂：设置页那个开关服务端也开不动 ───────────────────── */

describe('旗关：POST /api/v1/me/preferences 开不动境外', () => {
  function webUser(): { uid: number; token: string } {
    const uid = Number(
      db
        .prepare('INSERT INTO users (phone_hash, auth_status) VALUES (?, ?)')
        .run(`hash-${crypto.randomUUID()}`, '未认证').lastInsertRowid,
    );
    return { uid, token: signToken(uid) };
  }

  const prefPost = (token: string, body: unknown): Request =>
    new Request('http://localhost/api/v1/me/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  test('带 consent:true 也拒：400 TERMS_NOT_LIVE，开关没开、台账没落行', async () => {
    const { uid, token } = webUser();
    const res = await preferencesPost(prefPost(token, { overseas_models: true, consent: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('TERMS_NOT_LIVE');
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(false);
    expect(consentedKinds(db, uid), '拒了却还是把同意行落了下去').toEqual([]);
  });

  test('关掉境外、以及评测授权那一项，照常可用（旗只挡"开境外"这一件事）', async () => {
    const { uid, token } = webUser();
    const off = await preferencesPost(prefPost(token, { overseas_models: false }));
    expect(off.status, '关闭被旗挡住了——撤回不该有任何前置条件').toBe(200);

    const evalOn = await preferencesPost(prefPost(token, { eval_optin: true }));
    expect(evalOn.status, '评测授权是独立的一项，不该跟着协议旗一起停').toBe(200);
    expect(store.getModelPreferences(db, uid).evalOptin).toBe(true);
  });

  test('正对照：开臂上同一条请求 200 且开关真的开了', async () => {
    process.env[TERMS_LIVE_ENV] = '1';
    const { uid, token } = webUser();
    const res = await preferencesPost(prefPost(token, { overseas_models: true, consent: true }));
    expect(res.status).toBe(200);
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(true);
  });
});

/* ───────────────────── 关臂：不受旗管的那几样照常 ───────────────────── */
//
// 【为什么这一组也要有】旗的作用面必须**画得住边**。把它接到"凡是同意都停"上的形态是：
// 情绪记录与实名采用这两次单独同意跟着一起停——而它们与协议正文没有关系，
// 各自的告知早就定稿了，停掉只会让用户在对话里被反复问同一件事。
describe('旗关：情绪同意与实名同意不受影响', () => {
  test('consent_grant 那条路照常记情绪同意（不看旗）', async () => {
    const uid = Number(
      db
        .prepare('INSERT INTO users (phone_hash, auth_status) VALUES (?, ?)')
        .run(`hash-${crypto.randomUUID()}`, '未认证').lastInsertRowid,
    );
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.emotion });
    expect(consentedKinds(db, uid)).toContain(CONSENT_KINDS.emotion);
  });

  test('实名那一次单独同意照常拦、照常记（realnameConsentFailure 不看旗）', async () => {
    const { realnameConsentFailure } = await import('../consent');
    const uid = Number(
      db
        .prepare('INSERT INTO users (phone_hash, auth_status) VALUES (?, ?)')
        .run(`hash-${crypto.randomUUID()}`, '未认证').lastInsertRowid,
    );
    expect(
      realnameConsentFailure(db, uid, false, null),
      '旗关着就把实名那道单独同意也放行了 = 证件号在没点头之前就能收',
    ).not.toBeNull();

    expect(realnameConsentFailure(db, uid, true, null)).toBeNull();
    expect(consentedKinds(db, uid)).toContain(CONSENT_KINDS.realname);
  });
});

// 【变异矩阵】2026-09-07 逐条实跑（改产线代码 → 跑判据 → 改回），本文件 18 例，基线 18 通过：
//  · M-1 registrationConsentFailure 删掉 `if (!termsLive()) return null;`  ⇒ 1 失败 / 17 通过。
//  · M-2 recordRegistrationConsent 删掉 `if (!termsLive()) return;`       ⇒ 1 失败 / 17 通过。
//  · M-3 overseasModelsAllowed 删掉 `if (!termsLive()) return false;`     ⇒ 3 失败 / 15 通过。
//  · M-4 preferences 路由删掉 TERMS_NOT_LIVE 那一段                        ⇒ 1 失败 / 17 通过。
//  · M-5 termsLive() 恒 true   ⇒ 本组 10 失败 + UI 组 7 失败 = 17。
//  · M-6 termsLive() 恒 false  ⇒ 本组 7 失败 + UI 组 10 失败 = 17，
//        **并且**开臂那三组 19 失败（说明它们真的跑在开臂上，不是碰巧绿的）。
//    M-5/M-6 的改法要写明，否则数字对不上：**保留读 env 那一行、只把返回值钉死**。
//    连那一行一起删的形态是——单一读取口守卫也跟着红一条，凑成 18，
//    而那一条红说的是"读取口没走常量"，与"旗判反了"是两件事。
//  上述每一条变异下，开臂那三组（consent-gate / consent-routes / lifecycle-consents）
//  除 M-6 外全部照旧 50 通过——旗这件事的牙齿全长在关臂这一组身上。
