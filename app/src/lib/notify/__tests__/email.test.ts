// app/src/lib/notify/__tests__/email.test.ts
// 注入假 transport，不碰真 SMTP。
// 唯一的例外是最后那组：它用 nodemailer 的 streamTransport 把信**真的组装成 MIME 字节**，
// 只是不往外发。理由见那一组的注释——中文发件人名到底编没编对，只有看字节才知道。
import { beforeEach, describe, expect, test, vi } from 'vitest';

import nodemailer from 'nodemailer';

import { emailVerifyCode } from '../copy';
import { isValidEmail, sendMail } from '../email';
import type { MailTransport } from '../email';
import { renderMail } from '../mail-template';

const COPY = emailVerifyCode('123456', 5);

type SendMailArgs = Parameters<MailTransport['sendMail']>[0];

function spy() {
  return { sendMail: vi.fn(async (_options: SendMailArgs) => ({})) };
}

beforeEach(() => {
  process.env.SMTP_USERNAME = 'noreply@example.com';
  delete process.env.SMTP_FROM_ALIAS;
});

describe('sendMail', () => {
  test('主题与正文原样取自 copy，不在传输层二次拼接', async () => {
    const transport = spy();
    await sendMail('user@example.com', COPY, transport);
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('user@example.com');
    expect(sent.subject).toBe(COPY.subject);
    expect(sent.text).toBe(COPY.text);
  });

  test('排版版与品牌附件一并交给传输层', async () => {
    const transport = spy();
    await sendMail('user@example.com', COPY, transport);
    const sent = transport.sendMail.mock.calls[0][0];
    // 版式来自唯一入口 renderMail，传输层不得自己拼一份
    expect(sent.html).toBe(renderMail(COPY).html);
    expect(sent.attachments.map((a) => a.cid)).toEqual(['tubashu-logo', 'tubashu-mascot']);
  });
});

describe('发件人显示名（用户 2026-08-31：中文名＝土八鼠）', () => {
  test('SMTP_FROM_ALIAS 没配时兜底成「土八鼠」，不退回裸地址', async () => {
    // 【为什么这条是硬要求】退回裸地址是种没有告警的退化：邮件照发、日志全绿，
    // 只有收件人少看见一个名字，而收件人不会来报。
    const transport = spy();
    await sendMail('user@example.com', COPY, transport);
    expect(transport.sendMail.mock.calls[0][0].from).toBe('土八鼠 <noreply@example.com>');
  });

  test('空串与纯空白也算没配', async () => {
    for (const blank of ['', '   ']) {
      process.env.SMTP_FROM_ALIAS = blank;
      const transport = spy();
      await sendMail('user@example.com', COPY, transport);
      expect(transport.sendMail.mock.calls[0][0].from).toBe('土八鼠 <noreply@example.com>');
    }
  });

  test('配了就以 env 为准（临时改名不必动代码）', async () => {
    process.env.SMTP_FROM_ALIAS = '账号服务';
    const transport = spy();
    await sendMail('user@example.com', COPY, transport);
    expect(transport.sendMail.mock.calls[0][0].from).toBe('账号服务 <noreply@example.com>');
  });
});

describe('🔑 组出来的 MIME 字节（streamTransport，组装但不外发）', () => {
  // 【为什么必须看字节】「中文发件人名生效了吗」这个问题，
  // 断言 `from === '土八鼠 <…>'` 是答不了的——那只证明我们把字符串交出去了。
  // 收件端看到的是 RFC 2047 encoded-word；没编码的裸 UTF-8 在部分 MTA 上会变成乱码或被拒。
  // 这一组把信真的组装成字节，再从字节里把名字解回来。
  async function bytes(copy = COPY): Promise<string> {
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    let raw = '';
    const captured: MailTransport = {
      async sendMail(options) {
        const info = (await t.sendMail(options as never)) as { message: Buffer };
        raw = info.message.toString('utf8');
        return info;
      },
    };
    await sendMail('user@example.com', copy, captured);
    return raw;
  }

  test('From 头是 RFC 2047 编码过的「土八鼠」，不是裸 UTF-8', async () => {
    const raw = await bytes();
    const m = raw.match(/^From: (.+)$/m);
    expect(m, '没有 From 头').not.toBeNull();
    const from = m![1];
    expect(from).toContain('<noreply@example.com>');
    // 必须是 encoded-word 形式
    const ew = from.match(/=\?UTF-8\?B\?([^?]+)\?=/i);
    expect(ew, `From 头没做 encoded-word 编码：${from}`).not.toBeNull();
    // 解回来必须正是品牌名
    expect(Buffer.from(ew![1], 'base64').toString('utf8')).toBe('土八鼠');
  });

  test('纯文本与 HTML 两个部件都在（multipart/alternative）', async () => {
    const raw = await bytes();
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(raw).toMatch(/Content-Type: text\/html; charset=utf-8/);
  });

  test('两张品牌图作为 inline 附件带上，且 Content-ID 与 html 里的 cid 对得上', async () => {
    const raw = await bytes();
    expect(raw).toMatch(/Content-Type: image\/png/);
    for (const cid of ['tubashu-logo', 'tubashu-mascot']) {
      expect(raw, `缺 Content-ID: <${cid}>`).toContain(`Content-ID: <${cid}>`);
    }
    expect(raw).toMatch(/Content-Disposition: inline/);
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
