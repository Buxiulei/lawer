// app/src/app/api/v1/auth/__tests__/routes.test.ts
// 路由层的形状测试：请求体解析、Bearer 校验、错误 JSON 的字段名（snake_case）。
// 业务分支在 lib/auth 的单测里覆盖，这里只走**绝不会真的发出短信/邮件**的路径：
// 参数非法、缺 token、body 不是 JSON —— 全都在调用发送通道之前就返回了。
import { beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signToken, verifyToken } from '@/lib/auth';
import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';

type Handler = (req: Request) => Promise<Response>;
let smsSend: Handler;
let smsVerify: Handler;
let emailSend: Handler;
let emailVerify: Handler;
let emailRegisterSend: Handler;
let emailRegisterVerify: Handler;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/auth/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  // 库落到临时文件，别碰开发用的 data/lawer.db（client.ts 在模块加载时读 DB_PATH，故先设再 import）
  process.env.DB_PATH = path.join(
    os.tmpdir(),
    `lawer-auth-routes-${crypto.randomUUID()}.db`,
  );
  smsSend = (await import('../sms/send/route')).POST;
  smsVerify = (await import('../sms/verify/route')).POST;
  emailSend = (await import('../email/send/route')).POST;
  emailVerify = (await import('../email/verify/route')).POST;
  emailRegisterSend = (await import('../email/register/send/route')).POST;
  emailRegisterVerify = (await import('../email/register/verify/route')).POST;
});

describe('错误响应形状', () => {
  test('手机号非法 → 400 + snake_case 错误体（没走到发短信）', async () => {
    const res = await smsSend(post({ phone: '12345' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error_code: 'INVALID_PHONE',
      message: '手机号格式不正确',
    });
  });

  test('body 不是合法 JSON → 400 INVALID_BODY', async () => {
    const res = await smsSend(post('{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_BODY');
  });

  test('phone 字段缺失时按非法手机号处理，不抛 500', async () => {
    const res = await smsVerify(post({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_PHONE');
  });

  test('没发过码就验 → OTP_NOT_FOUND', async () => {
    const res = await smsVerify(post({ phone: '13800138000', code: '123456' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('OTP_NOT_FOUND');
  });
});

describe('邮箱两条路由的 Bearer 校验', () => {
  // 单因素登录后 Authorization 变成可选：没带 = 匿名走邮箱通道登录。
  // 判据挑「格式非法」而不是「陌生邮箱」，是因为后者现在要走完整条路（会真的去发邮件）——
  // 那条路的判据在 lib/auth 的 single-factor 里，那边能注入假邮件通道。这里只问一件事：
  // **缺 Authorization 头不再是 401**，请求确实进到了业务层。
  test('缺 Authorization 头不再被拒：请求照常进业务层（这里被邮箱格式拦下）', async () => {
    for (const handler of [emailSend, emailVerify]) {
      const res = await handler(post({ email: 'not-an-email', code: '123456' }));
      expect(res.status).toBe(400);
      expect((await res.json()).error_code).toBe('INVALID_EMAIL');
    }
  });

  /**
   * 匿名验码撞上一个陌生邮箱，回的是 OTP_NOT_FOUND（「请先获取验证码」）——
   * 与「已注册但还没发过码」**同一个回答**。库里一个用户都没有，这条走的正是陌生那一支。
   * 早先它回 404 EMAIL_NOT_REGISTERED，一次请求就能问出注册状态。
   */
  test('🔴 匿名验陌生邮箱 → OTP_NOT_FOUND，不再有专属于「没注册」的错误码', async () => {
    const res = await emailVerify(post({ email: 'a@b.com', code: '123456' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('OTP_NOT_FOUND');
  });

  /**
   * 【这条是鉴权强度本身】"可选"只对**根本没带**成立。
   * 若把「带了个过期 token」也当匿名放过去，权限判定就从「通过 / 不通过」
   * 变成了「不通过就换一条路」——凭据失效反而解锁了另一套语义。
   * 判据不看 401 而看 error_code：降级成匿名时这里会变成 404，一眼可辨。
   */
  test('token 伪造或过期 → 401，绝不降级成匿名', async () => {
    const expired = signToken(1, new Date('2020-01-01T00:00:00Z'));
    for (const bad of [`Bearer ${expired}`, 'Bearer nonsense', 'Basic abc', '']) {
      for (const handler of [emailSend, emailVerify]) {
        const res = await handler(
          post({ email: 'a@b.com', code: '123456' }, { authorization: bad }),
        );
        expect(res.status, `坏 token「${bad}」被放过了`).toBe(401);
        expect((await res.json()).error_code).toBe('UNAUTHORIZED');
      }
    }
  });

  test('token 有效但邮箱格式不对 → 400 INVALID_EMAIL（没走到发邮件）', async () => {
    const token = signToken(1);
    const res = await emailVerify(
      post({ email: 'not-an-email', code: '123456' }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_EMAIL');
  });
});

describe('邮箱注册两条路由：匿名可达', () => {
  // 这两条是开户入口，调用它的人本来就还没有账号——**要求 Bearer 等于把注册关掉**。
  // 判据取「不带任何凭据时越过了鉴权、落在业务校验上」，而不是「返回 200」：
  // 用非法邮箱正好能在不发出任何邮件的前提下证明这一点。
  test('不带 Authorization 也不回 401，直接走到业务校验（400 INVALID_EMAIL）', async () => {
    for (const handler of [emailRegisterSend, emailRegisterVerify]) {
      const res = await handler(post({ email: 'not-an-email', code: '123456' }));
      expect(res.status).toBe(400);
      expect((await res.json()).error_code).toBe('INVALID_EMAIL');
    }
  });

  test('body 不是合法 JSON → 400 INVALID_BODY', async () => {
    for (const handler of [emailRegisterSend, emailRegisterVerify]) {
      const res = await handler(post('{not json'));
      expect(res.status).toBe(400);
      expect((await res.json()).error_code).toBe('INVALID_BODY');
    }
  });

  test('没发过注册码就验 → OTP_NOT_FOUND（不会误命中绑定桶）', async () => {
    const res = await emailRegisterVerify(
      post({ email: 'nobody@example.com', code: '123456' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('OTP_NOT_FOUND');
  });

  // 【为什么还要一条「文件在不在」】Next 里 URL 就是目录路径。上面每条测试都是用相对
  // import 把 handler 拿到手的——把 register/send 整个挪走、或者合并时解冲突解掉一个目录，
  // 只要 import 还指得到，它们**照样全绿**，而线上那条 URL 已经 404 了。
  // 这条把「磁盘上有哪几个 route.ts」钉成一个集合：多一条少一条都红。
  test('两条路由的目录即 URL：磁盘上就这两条，不多不少', () => {
    const dir = fileURLToPath(new URL('../email/register/', import.meta.url));
    const found = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'route.ts')))
      .map((e) => `/api/v1/auth/email/register/${e.name}`)
      .sort();
    expect(found).toEqual([
      '/api/v1/auth/email/register/send',
      '/api/v1/auth/email/register/verify',
    ]);
  });

  // 【为什么整体形状要在路由这一层钉一次】lib 侧返回的是驼峰的 isNewUser / retryAfter /
  // onboarding.caseId，前端读的是下划线的 is_new_user / retry_after / onboarding.case_id。
  // 中间这一次改名只发生在路由里，而**上面那些测试全都停在发送之前**，一个字段都没读过：
  // 路由把某个字段整条漏掉（自查时 retry_after、onboarding 各漏一次都是全绿）、
  // 或者拼成驼峰、或者 is_new_user 恒填 true，lib 那边的判据一条都不会红。
  // 所以这里用 toEqual 钉**整个响应体**——多一个字段少一个字段都算变。
  test('🔴 两条路由的响应体逐字段对得上：is_new_user 首次 true 再来 false，retry_after 与 onboarding 都不许漏', async () => {
    // 这条要真的走完发码那一步（前面几条都刻意停在发送之前），用干跑开关挡住 SMTP：
    // 码照常入库，一封信也不会真发出去。
    process.env.NOTIFY_DRY_RUN = '1';
    try {
      const email = `newcomer-${crypto.randomUUID()}@example.com`;
      const sent = await emailRegisterSend(post({ email }));
      expect(sent.status, '发码没走通，下面两步就无从谈起').toBe(200);
      // retry_after 是前端那个 60 秒倒计时的唯一来源；漏了它，用户只能盲点重发。
      expect(await sent.json()).toEqual({
        ok: true,
        ttl_seconds: expect.any(Number),
        retry_after: 60,
      });

      const db = (await import('@/lib/db/client')).getDb();
      const first = await emailRegisterVerify(
        post({ email, code: store.latestEmailCode(db, email, store.EMAIL_PURPOSE.register)!.code }),
      );
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      // onboarding 是「开完户进站落在哪个案件」的唯一来源；漏了它，新用户进站后无处可去。
      expect(firstBody).toEqual({
        ok: true,
        token: expect.any(String),
        is_new_user: true,
        onboarding: { case_id: expect.any(Number), is_new: true },
      });
      const uid = verifyToken(firstBody.token)!.uid;

      // 第二次登录直接补一条同桶的码：发码那条路有 60 秒冷却，为了测 is_new_user 的语义
      // 去跟真实时钟赛跑没有意义，冷却本身在 lib 侧已经有判据。
      const code2 = '654321';
      store.insertEmailCode(db, {
        email,
        code: code2,
        purpose: store.EMAIL_PURPOSE.register,
        expiresAt: toSql(new Date(Date.now() + 5 * 60 * 1000)),
        createdAt: toSql(new Date()),
      });
      const second = await emailRegisterVerify(post({ email, code: code2 }));
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody).toEqual({
        ok: true,
        token: expect.any(String),
        is_new_user: false, // 老用户回来登录不该被当成新人
        onboarding: { case_id: firstBody.onboarding.case_id, is_new: false },
      });
      expect(verifyToken(secondBody.token)!.uid, '第二次登录落到了另一个账号').toBe(uid);
    } finally {
      delete process.env.NOTIFY_DRY_RUN;
    }
  });

  test('/api/manifest 里这两条标 auth:none，与上面实测的行为对得上', async () => {
    // 分开写会各自为真而互相说谎：manifest 标 'jwt' 的话，读它接入的 agent
    // 永远不会尝试匿名调用——**一条能用但没人知道能用的开户接口，等于没有**。
    const manifest = await (await (await import('@/app/api/manifest/route')).GET()).json();
    const paths = ['/api/v1/auth/email/register/send', '/api/v1/auth/email/register/verify'];
    for (const path of paths) {
      const entry = (manifest.rest.endpoints as { path: string; auth: string }[]).find(
        (e) => e.path === path,
      );
      expect(entry, `manifest 里没有 ${path}`).toBeDefined();
      expect(entry!.auth).toBe('none');
    }
  });
});
