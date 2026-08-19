// app/src/app/api/v1/auth/__tests__/routes.test.ts
// 路由层的形状测试：请求体解析、Bearer 校验、错误 JSON 的字段名（snake_case）。
// 业务分支在 lib/auth 的单测里覆盖，这里只走**绝不会真的发出短信/邮件**的路径：
// 参数非法、缺 token、body 不是 JSON —— 全都在调用发送通道之前就返回了。
import { beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { signToken } from '@/lib/auth';

type Handler = (req: Request) => Promise<Response>;
let smsSend: Handler;
let smsVerify: Handler;
let emailSend: Handler;
let emailVerify: Handler;

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
  test('缺 Authorization 头 → 401 UNAUTHORIZED', async () => {
    for (const handler of [emailSend, emailVerify]) {
      const res = await handler(post({ email: 'a@b.com', code: '123456' }));
      expect(res.status).toBe(401);
      expect((await res.json()).error_code).toBe('UNAUTHORIZED');
    }
  });

  test('token 伪造或过期 → 401', async () => {
    const expired = signToken(1, new Date('2020-01-01T00:00:00Z'));
    for (const bad of [`Bearer ${expired}`, 'Bearer nonsense', 'Basic abc']) {
      const res = await emailSend(post({ email: 'a@b.com' }, { authorization: bad }));
      expect(res.status).toBe(401);
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
