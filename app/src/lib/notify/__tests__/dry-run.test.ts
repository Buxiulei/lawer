// app/src/lib/notify/__tests__/dry-run.test.ts
// 开发用的发送干跑开关。两件事必须钉死：
//   1. 开发环境 NOTIFY_DRY_RUN=1 时**一个字节都不往外发**（连凭证都不用配）
//   2. 生产环境该开关**必须失效**——生产静默不发验证码等于全员登不进来，
//      且现象是"显示发送成功却收不到"，是最难查的那类故障
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { sendMail } from '../email';
import { sendOtp } from '../sms';

const PHONE = '13800138000';
const EMAIL = 'user@example.com';
const COPY = { subject: '验证码', text: '你的验证码是 123456' };

/** 假 fetch：被调到就说明真的发了短信 */
function spyFetch() {
  const impl = vi.fn(async () => new Response(JSON.stringify({ Code: 'OK' })));
  return impl as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

beforeEach(() => {
  vi.stubEnv('ALIYUN_ACCESS_KEY_ID', 'test-id');
  vi.stubEnv('ALIYUN_ACCESS_KEY_SECRET', 'test-secret');
  vi.stubEnv('SMS_SIGN_NAME', '测试签名');
  vi.stubEnv('SMS_TEMPLATE_VERIFY_CODE', 'SMS_123456789');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('NOTIFY_DRY_RUN 生效（非生产环境）', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NOTIFY_DRY_RUN', '1');
  });

  test('短信不真发，且打一行醒目日志', async () => {
    const fetchImpl = spyFetch();
    await expect(sendOtp(PHONE, '123456', fetchImpl)).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    const line = (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(line).toContain('NOTIFY_DRY_RUN');
    // 验证码本身不进日志（email.ts「验证码进日志是事故」同一条原则）
    expect(line).not.toContain('123456');
    // 手机号打码
    expect(line).not.toContain(PHONE);
  });

  test('邮件不真发，也不去建 SMTP transporter', async () => {
    const transport = { sendMail: vi.fn(async () => undefined) };
    await expect(sendMail(EMAIL, COPY, transport)).resolves.toBeUndefined();
    expect(transport.sendMail).not.toHaveBeenCalled();

    // 连 SMTP 都没配也不该抛错——这正是开关的用处
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USERNAME', '');
    vi.stubEnv('SMTP_PASSWORD', '');
    await expect(sendMail(EMAIL, COPY)).resolves.toBeUndefined();
  });

  test('短信凭证没配也走得通（开发机不必配阿里云）', async () => {
    vi.stubEnv('SMS_SIGN_NAME', '');
    vi.stubEnv('SMS_TEMPLATE_VERIFY_CODE', '');
    const fetchImpl = spyFetch();
    await expect(sendOtp(PHONE, '123456', fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('手机号格式仍然要校验，干跑不等于不校验', async () => {
    const fetchImpl = spyFetch();
    await expect(sendOtp('12345', '123456', fetchImpl)).rejects.toThrow('无效的手机号');
  });
});

describe('生产环境忽略该开关', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NOTIFY_DRY_RUN', '1');
  });

  test('短信照常真发，并打 error 告警', async () => {
    const fetchImpl = spyFetch();
    await sendOtp(PHONE, '123456', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(
      (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0],
    ).toContain('生产环境忽略 NOTIFY_DRY_RUN');
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('邮件照常真发', async () => {
    const transport = { sendMail: vi.fn(async () => undefined) };
    await sendMail(EMAIL, COPY, transport);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('开关未开时行为不变', () => {
  test('NOTIFY_DRY_RUN 缺省 → 照常真发，无额外日志', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NOTIFY_DRY_RUN', '');
    const fetchImpl = spyFetch();
    await sendOtp(PHONE, '123456', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test('NOTIFY_DRY_RUN=true / 0 之类的值不认，只认精确的 "1"', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const value of ['true', '0', 'yes']) {
      vi.stubEnv('NOTIFY_DRY_RUN', value);
      const fetchImpl = spyFetch();
      await sendOtp(PHONE, '123456', fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
