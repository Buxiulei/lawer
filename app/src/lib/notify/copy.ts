// app/src/lib/notify/copy.ts
//
// 【产品硬约束：所有出站通知文案只许写在这一个文件里】
//
// 来由：用户多半还在原公司上班，手机会在工位上亮、邮件会在共用电脑上弹横幅。
// 一条「您的仲裁申请书已生成」或者主题里带「劳动仲裁」的邮件被工位旁边的人瞟到，
// 等于替用户向 HR 公开了他正在维权 —— 这个后果不可逆，比少一点文案信息量严重得多。
// 所以：
//   1. 默认（neutral）模式下，短信正文、邮件主题、邮件正文一律不得出现
//      「裁员 / 仲裁 / 开庭 / 劳动 / 律师 / 赔偿 / 解除」等敏感词，也不得出现平台名。
//      提醒类一律退化成「您有新的日程提醒」这类看不出所以然的表述。
//   2. detailed 模式是用户**自己**在设置里打开的（表字段由 WS1 后续提供），
//      打开后才允许出现平台名与事项类型。现在没有那张表，先用参数传入，默认 false。
//   3. 任何模块要发通知，都从这里取文案；不许在 sms.ts / email.ts / 业务代码里现拼字符串。
//      这样"有没有踩敏感词"只需要审这一个文件。
//
// 验证码短信是唯一的例外：正文由阿里云模板（SMS_TEMPLATE_VERIFY_CODE）决定，
// 我们只能传变量，所以这里只负责拼 TemplateParam。选模板时同样按上面第 1 条把关。

/**
 * **出站通知里只用「土拨鼠」，不用全称「土拨鼠劳动仲裁」。**
 *
 * 全称里「劳动」「仲裁」都在上面第 1 条的敏感词清单里——
 * 而本文件开头那个例子正是「主题里带『劳动仲裁』的邮件被工位旁边的人瞟到」。
 * 改名前的全称只含一个敏感词（裁员），改名后含两个，**放进主题就是本文件存在的理由所反对的东西**。
 *
 * detailed 模式的目的写在下面：「便于用户在一堆验证码邮件里认出是哪家」——
 * 「土拨鼠」把这件事做到了，且一个敏感词都不带。
 *
 * 还有一层：detailed 是用户**早先**打开的开关，他当时同意露出的是旧名字。
 * 改名不该让一个已经给过的同意，悄悄变成露出「劳动仲裁」四个字。
 */
const NOTIFY_BRAND = '土拨鼠';

/** 出站文案的详略模式。detailed 需用户在设置里显式打开，默认中性。 */
export interface CopyOptions {
  /** true = 允许出现平台名与事项类型；默认 false（中性措辞） */
  detailed?: boolean;
}

/** 邮件文案：主题 + 纯文本正文。HTML 版留给真正需要排版的场景，验证码不需要。 */
export interface MailCopy {
  subject: string;
  text: string;
}

/**
 * 验证码短信的 TemplateParam。
 * 正文措辞取决于阿里云模板本身，本函数只填变量；模板必须是通用「验证码」模板，
 * 不得申请带业务描述（如「仲裁提醒」）的签名或模板。
 */
export function smsVerifyTemplateParam(code: string): string {
  return JSON.stringify({ code });
}

/**
 * 邮箱验证码邮件。
 * neutral：主题只说「验证码」，正文不出现平台名，收件人看横幅只知道自己在验邮箱。
 * detailed：允许带上平台名，便于用户在一堆验证码邮件里认出是哪家。
 */
export function emailVerifyCode(
  code: string,
  expiryMinutes: number,
  options: CopyOptions = {},
): MailCopy {
  if (options.detailed) {
    return {
      subject: `${NOTIFY_BRAND} 邮箱验证码：${code}`,
      text: `您正在验证${NOTIFY_BRAND}账号的邮箱地址。\n验证码：${code}\n${expiryMinutes} 分钟内有效，请勿转发他人。\n若非本人操作，忽略本邮件即可。`,
    };
  }
  return {
    subject: `验证码：${code}`,
    text: `您的验证码是 ${code}，${expiryMinutes} 分钟内有效，请勿转发他人。\n若非本人操作，忽略本邮件即可。`,
  };
}
