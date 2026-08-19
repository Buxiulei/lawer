// app/src/lib/notify/email.ts
// SMTP 薄客户端（腾讯企业邮 smtp.exmail.qq.com:465 SSL），写法参照 /home/roots/六爻/app/src/lib/auth/email.ts。
// 文案不在这里拼，全部来自 copy.ts。
import nodemailer from 'nodemailer';
import type { MailCopy } from './copy';

/** nodemailer transporter 的最小契约，测试可注入假实现 */
export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

let cached: MailTransport | null = null;

/**
 * 读 env 建 transporter。
 * 与六爻不同：SMTP 未配置时**直接抛错**而不是回退 console。
 * 验证码走 console 意味着生产上配漏了也照样「发送成功」，等于把验证码打进日志，
 * 和 lib/crypto「不做静默降级」同一条原则。
 */
function getTransport(): MailTransport {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USERNAME;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    throw new Error('SMTP 凭证未配置：需要 SMTP_HOST / SMTP_USERNAME / SMTP_PASSWORD');
  }
  cached = nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return cached;
}

/** 发件人显示名取 SMTP_FROM_ALIAS，缺省时只用地址（别名本身也受 copy.ts 的中性约束） */
function fromAddress(): string {
  const user = process.env.SMTP_USERNAME!;
  const alias = process.env.SMTP_FROM_ALIAS;
  return alias ? `${alias} <${user}>` : user;
}

/**
 * 发一封纯文本邮件。
 * @param transport 测试注入用，默认走 env 建出的 SMTP transporter
 */
export async function sendMail(
  to: string,
  copy: MailCopy,
  transport: MailTransport = getTransport(),
): Promise<void> {
  await transport.sendMail({
    from: fromAddress(),
    to,
    subject: copy.subject,
    text: copy.text,
  });
}

/** 校验邮箱格式：一个 @、两侧非空、域名带点且无空白 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '');
}
