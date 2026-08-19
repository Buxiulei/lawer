// app/src/lib/notify/__tests__/email.test.ts
// 注入假 transport，不碰真 SMTP。
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { isValidEmail, sendMail } from '../email';
import type { MailTransport } from '../email';

const COPY = { subject: '验证码：123456', text: '您的验证码是 123456' };

type SendMailArgs = Parameters<MailTransport['sendMail']>[0];

beforeEach(() => {
  process.env.SMTP_USERNAME = 'noreply@example.com';
  delete process.env.SMTP_FROM_ALIAS;
});

describe('sendMail', () => {
  test('主题与正文原样取自 copy，不在传输层二次拼接', async () => {
    const transport = { sendMail: vi.fn(async () => ({})) };
    await sendMail('user@example.com', COPY, transport);
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: COPY.subject,
      text: COPY.text,
    });
  });

  test('SMTP_FROM_ALIAS 存在时拼成 "别名 <地址>"', async () => {
    process.env.SMTP_FROM_ALIAS = '账号服务';
    const transport = { sendMail: vi.fn(async (_options: SendMailArgs) => ({})) };
    await sendMail('user@example.com', COPY, transport);
    expect(transport.sendMail.mock.calls[0][0].from).toBe('账号服务 <noreply@example.com>');
  });
});

describe('isValidEmail', () => {
  test('基本格式校验', () => {
    for (const good of ['a@b.com', 'user.name+tag@sub.example.cn']) {
      expect(isValidEmail(good)).toBe(true);
    }
    for (const bad of ['', 'a@b', 'a b@c.com', '@b.com', 'a@@b.com', 'ab.com']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});
