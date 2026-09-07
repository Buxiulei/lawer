// app/src/app/api/v1/__tests__/consent-routes.test.ts
// 其余三个同意采集点的路由判据（协议 五.2（1）、五.3、五.5（2）/ 附一 #4、#5、#6）：
//   · POST /api/v1/realname/init   —— 收证件号**之前**那一次单独同意；
//   · POST /api/v1/consents        —— 页面上「我同意」按钮的落点（白名单）；
//   · POST /api/v1/me/preferences  —— 境外模型与评测授权两个开关。
//
// 【为什么实名那条的判据要盯"零写入"而不只是状态码】"问在收之前"这句承诺，
// 只有在**没同意时一个字节都没进来**的前提下才成立。回了 400 但已经把姓名和证件号
// 读进进程、甚至落了库的形态是：状态码看着对，承诺已经破了，而没有任何一处报错。
//
// 【变异矩阵】2026-09-07 实跑，结果照抄在各 describe 抬头。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CONSENT_KINDS } from '@/lib/consent';
import { consentedKinds, hasConsent, recordConsent } from '@/lib/db/consents';
import * as store from '@/lib/db/otp';

type Handler = (req: Request) => Promise<Response>;
let realnameInit: Handler;
let consentsPost: Handler;
let preferencesPost: Handler;
let db: Database;
let signToken: (uid: number) => string;

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-consent-routes-${crypto.randomUUID()}.db`);
  realnameInit = (await import('@/app/api/v1/realname/init/route')).POST;
  consentsPost = (await import('@/app/api/v1/consents/route')).POST;
  preferencesPost = (await import('@/app/api/v1/me/preferences/route')).POST;
  signToken = (await import('@/lib/auth')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

let uid: number;
let token: string;

beforeEach(() => {
  // 每个用例一个新账号：同意是**累积**的，共用账号会让后一个用例的"没同意"臂
  // 悄悄变成"上一个用例已经同意过"——那时它测的是别的东西，而且照样绿。
  uid = Number(
    db
      .prepare('INSERT INTO users (phone_hash, auth_status) VALUES (?, ?)')
      .run(`hash-${crypto.randomUUID()}`, '未认证').lastInsertRowid,
  );
  token = signToken(uid);
});

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const authStatus = (): string =>
  (db.prepare('SELECT auth_status FROM users WHERE id=?').get(uid) as { auth_status: string }).auth_status;

const realnameRows = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM realname_verifications WHERE user_id=?').get(uid) as { n: number }).n;

/* ─────────── 实名：收证件号之前那一次单独同意（协议 五.2（1）） ─────────── */
//
// 【变异臂】2026-09-07 实跑，本文件 12 例：
//  · R-1 realname/init 拿到闸的失败却不返回        ⇒ 2 失败 / 9 通过（没同意也照收）。
//  · R-2 realnameConsentFailure 同意了却不落台账行 ⇒ 1 失败 / 10 通过（日后证明不了他同意过）。
describe('实名认证：没同意就不许开始收证件号', () => {
  test('没带同意位 ⇒ 400 CONSENT_REQUIRED，且**零写入**（台账、快照、状态都没动）', async () => {
    const res = await realnameInit(post('/api/v1/realname/init', { real_name: '张三', id_card: '110101199003071234' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('CONSENT_REQUIRED');
    expect(consentedKinds(db, uid), '没同意就一行台账都不该落').toEqual([]);
    expect(realnameRows(), '没同意就不该落实名快照').toBe(0);
    expect(authStatus(), '状态不该被动过').toBe('未认证');
  });

  test('拒绝时的自述三段式：缺什么 / 为什么 / 怎么办，且写明不同意也能用', async () => {
    const res = await realnameInit(post('/api/v1/realname/init', { real_name: '张三', id_card: '110101199003071234' }));
    const message = String((await res.json()).message);

    expect(message, '缺什么').toContain('单独同意');
    expect(message, '为什么要收').toContain('存证');
    expect(message, '怎么办').toContain('实名页');
    // 【为什么这一句必须在】不写"不同意也能用"的形态是：单独同意读起来像必答题，
    // 而它按设计就是可以拒绝的——能被单独拒绝正是单独同意的全部意义。
    expect(message, '不同意的后果要说清').toContain('不同意');
  });

  test('带了同意位 ⇒ 台账当场落一行 realname（在读证件号之前就落）', async () => {
    // 【为什么这条不断言实名成功】上游刷脸要真的联通阿里云，本用例没有也不该有那个环境。
    // 这里量的是"同意有没有在收之前被记下"——那正是协议五.2（1）承诺的那件事。
    await realnameInit(post('/api/v1/realname/init', { real_name: '张三', id_card: '110101199003071234', consent: true }));
    expect(hasConsent(db, uid, CONSENT_KINDS.realname)).toBe(true);
  });

  test('同意过一次之后不再问第二遍（刷脸没做完、回来重发一次）', async () => {
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.realname });
    const res = await realnameInit(post('/api/v1/realname/init', { real_name: '张三', id_card: '110101199003071234' }));
    // 同一件事反复要求点头，用户会把它读成"点了没生效"
    expect(res.status, '此前同意过就不该再被 CONSENT_REQUIRED 拦住').not.toBe(400);
  });
});

/* ─────────── POST /api/v1/consents：白名单 ─────────── */
describe('同意落点路由：只收该由这条路收的那两类', () => {
  test('emotion 与 realname_adopt 收得下，且重复点不报错', async () => {
    for (const kind of [CONSENT_KINDS.emotion, CONSENT_KINDS.realnameAdopt]) {
      const first = await consentsPost(post('/api/v1/consents', { kind }));
      expect(first.status).toBe(200);
      expect((await first.json()).first_time).toBe(true);

      // 用户在两个标签页各点一次，第二次回 4xx 会让人以为刚才那次没生效
      const again = await consentsPost(post('/api/v1/consents', { kind }));
      expect(again.status).toBe(200);
      expect((await again.json()).first_time).toBe(false);
    }
  });

  test('terms / adult / realname / overseas 四类**收不下**（各有自己的采集点）', async () => {
    for (const kind of [
      CONSENT_KINDS.terms,
      CONSENT_KINDS.adult,
      CONSENT_KINDS.realname,
      CONSENT_KINDS.overseas,
    ]) {
      const res = await consentsPost(post('/api/v1/consents', { kind }));
      // 把它们也开在通用路由上，等于给"没看过说明也能同意"开一扇门
      expect(res.status, `${kind} 不该从这条通用路由收`).toBe(400);
      expect((await res.json()).error_code).toBe('INVALID_KIND');
      expect(hasConsent(db, uid, kind), `${kind} 一行都不该落`).toBe(false);
    }
  });
});

/* ─────────── POST /api/v1/me/preferences：两个开关 ─────────── */
//
// 【变异臂】2026-09-07 实跑，本文件 12 例：
//  · P-1 开境外不再要求 consent:true              ⇒ 1 失败 / 10 通过
//        （谁都可以直接 POST 一次把开关打开，而"我们向你说明过"没有落点）。
//  · P-2 关闭也要求同意（`overseas !== undefined`）⇒ 1 失败 / 11 通过。
//        【这条最初没抓住】原来那一臂先用 consent:true 开了一次再关，
//        台账里已经有行，闸本来就放行——量的不是"关闭免检"。改成用**从没同意过**
//        的人去关，才走到那一支。先审量具再信读数。
describe('设置页两个开关', () => {
  test('两个开关的出厂状态都是关（未问即未同意，不是编出来的默认值）', () => {
    expect(store.getModelPreferences(db, uid)).toEqual({ overseasModels: false, evalOptin: false });
  });

  test('开境外但不带 consent ⇒ 400 CONSENT_REQUIRED，开关**没被打开**', async () => {
    const res = await preferencesPost(post('/api/v1/me/preferences', { overseas_models: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('CONSENT_REQUIRED');
    expect(store.getModelPreferences(db, uid).overseasModels, '闸没过就不许开').toBe(false);
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas)).toBe(false);
  });

  test('带 consent:true ⇒ 开关打开，台账同时落一行', async () => {
    const res = await preferencesPost(post('/api/v1/me/preferences', { overseas_models: true, consent: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).overseas_models).toBe(true);
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(true);
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas)).toBe(true);
  });

  test('**从没同意过的人**把开关关掉，一样放行（撤回不设前置条件）', async () => {
    // 【为什么这一臂要用"从没同意过"的人】拿一个刚同意过的人去测关闭，
    // 是走不到闸那一支的——台账里已经有行，闸本来就放行。那样的用例
    // 把"关闭免检"和"他已经同意过"两件事混在一起，闸装反了也照样绿。
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas), '前提自检：这一臂的人从没同意过').toBe(false);
    const off = await preferencesPost(post('/api/v1/me/preferences', { overseas_models: false }));
    expect(off.status, '关掉一个本来就关着的开关，不该要他先同意什么').toBe(200);
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(false);
  });

  test('开过之后再关掉：开关回到关，但台账那一行留着', async () => {
    await preferencesPost(post('/api/v1/me/preferences', { overseas_models: true, consent: true }));
    const off = await preferencesPost(post('/api/v1/me/preferences', { overseas_models: false }));
    expect(off.status).toBe(200);
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(false);
    // 关掉不等于没发生过：开关记的是"现在生效的是什么"，台账记的是"发生过的事实"
    expect(hasConsent(db, uid, CONSENT_KINDS.overseas), '关掉开关不该抹掉他曾经同意过的记录').toBe(true);
  });

  test('再次开启时不必重新同意（台账里已经有了），且评测授权是独立的一项', async () => {
    await preferencesPost(post('/api/v1/me/preferences', { overseas_models: true, consent: true }));
    await preferencesPost(post('/api/v1/me/preferences', { overseas_models: false }));

    const again = await preferencesPost(post('/api/v1/me/preferences', { overseas_models: true }));
    expect(again.status).toBe(200);
    expect(store.getModelPreferences(db, uid).overseasModels).toBe(true);

    // 评测授权与境外各自可以单独开关（两列而不是一个偏好 JSON，见 migrate.ts）
    const evalOn = await preferencesPost(post('/api/v1/me/preferences', { eval_optin: true }));
    expect(evalOn.status).toBe(200);
    expect(store.getModelPreferences(db, uid)).toEqual({ overseasModels: true, evalOptin: true });
  });
});
