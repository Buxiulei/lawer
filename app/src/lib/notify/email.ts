// app/src/lib/notify/email.ts
// SMTP 薄客户端（腾讯企业邮 smtp.exmail.qq.com:465 SSL），写法参照 /home/roots/六爻/app/src/lib/auth/email.ts。
// 文案不在这里拼，全部来自 copy.ts。
import nodemailer from 'nodemailer';
import { NOTIFY_BRAND } from './copy';
import type { MailCopy } from './copy';
import { shouldDryRun } from './dry-run';
import { renderMail } from './mail-template';
import type { BrandAsset } from './brand-assets';

/** nodemailer transporter 的最小契约，测试可注入假实现 */
export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    /** 排版版；纯文本部件仍照发，客户端自己挑（multipart/alternative） */
    html: string;
    /** 品牌图，cid 内联（见 mail-template.ts 顶部为什么不用外链） */
    attachments: BrandAsset[];
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

/**
 * 发件人显示名。取 SMTP_FROM_ALIAS，**没配就兜底成品牌名**（用户 2026-08-31：发件人中文名＝土八鼠）。
 *
 * 【为什么要代码侧兜底，而不是"配好 env 就行"】
 * 原来的写法在 alias 缺失时退回裸地址，收件箱里显示成 `noreply@…`。
 * 那是一种**看不出坏了的坏**：邮件照发、日志全绿、没有任何告警，
 * 只有收件人那一侧少了个名字，而收件人不会来报。env 漏配是常态（换机器、改部署、加环境），
 * 让默认值落在代码里，漏配的代价就从"静默退化"变成"零"。
 * env 仍然优先——要临时换名字不必改代码。
 *
 * 中文名不需要在这里做 MIME 编码：nodemailer 组头时会自己转成 RFC 2047 encoded-word
 * （实测 `土八鼠` → `=?UTF-8?B?5Zyf5YWr6byg?=`），下面的测试把这条钉住。
 *
 * 别名同样受 copy.ts 的中性约束——它在收件箱列表里是露出来的。
 */
function fromAddress(): string {
  const user = process.env.SMTP_USERNAME!;
  const alias = process.env.SMTP_FROM_ALIAS?.trim() || NOTIFY_BRAND;
  return `${alias} <${user}>`;
}

/**
 * 发一封信：纯文本 + 排版 HTML 双部件。
 * @param transport 测试注入用，不传则走 env 建出的 SMTP transporter
 *
 * transport 不写成默认参数值（`= getTransport()`）：默认值在进函数体前就求值，
 * 缺 SMTP 配置时会先抛错，NOTIFY_DRY_RUN 的短路根本轮不到执行。
 *
 * 【排版在 mail-template，不在这里】本层只投递，不拼一个字、不选一个色——
 * 与 copy.ts 顶部"文案只许写在一处"同一条原则，版式也只许写在一处。
 */
export async function sendMail(
  to: string,
  copy: MailCopy,
  transport?: MailTransport,
): Promise<void> {
  if (shouldDryRun('邮件', to)) return;
  const mail = renderMail(copy);
  await (transport ?? getTransport()).sendMail({
    from: fromAddress(),
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments,
  });
}

/** 校验邮箱格式：一个 @、两侧非空、域名带点且无空白 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '');
}
