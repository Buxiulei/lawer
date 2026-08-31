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
 * 出站通知里出现的品牌名。**当前品牌名「土八鼠」本身不含任何敏感词**，
 * 所以它就是全称，没有另设短名。
 *
 * **这个常量仍然单独存在，是因为它守的是一条会再次被踩的线**：
 * 上一个品牌名叫「土拨鼠劳动仲裁」，「劳动」「仲裁」都在本文件开头第 1 条的敏感词清单里——
 * 而开头那个例子正是「主题里带『劳动仲裁』的邮件被工位旁边的人瞟到」。
 * 当时的处置是出站只用短名「土拨鼠」。
 *
 * 所以：**改名时不要想当然地把新名字直接塞进邮件主题**，
 * 先对着第 1 条的清单过一遍。品牌名是品牌层的决定，
 * 而出站文案里露出什么，是隐私层早先对用户做过的承诺——
 * **改名不该悄悄放大一个已经给过的同意。**
 * 下面的测试会替你查（新名带敏感词就会红）。
 */
const NOTIFY_BRAND = '土八鼠';

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
 * 期限提醒邮件（manager 2026-08-29 派）。
 *
 * 【为什么连"什么期限"都不说】本文件顶部那条产品约束在这里最吃紧：
 * 收件人可能在工位上、在家人旁边看手机横幅。一封主题写着「仲裁时效还剩 3 天」的邮件
 * 被旁人瞟见，泄露的不是一个日期，是**他正在维权这件事本身**。
 * 所以中性模式下**连事项类型都不给**——只说"有一项重要事项"，
 * 具体是什么，让他登录进来看。
 *
 * 【为什么不带链接以外的任何细节】剩余天数是给他判断紧急度的最小必要信息；
 * 案件标题、条款、金额一律不进邮件。
 *
 * detailed 模式留给用户显式开了 notify_verbose 的情形（users.notify_verbose），
 * 那是他自己选的——此时才允许出现事项类型。
 */
export function deadlineReminder(
  daysLeft: number,
  kind: string,
  options: CopyOptions = {},
): MailCopy {
  // 【主题与正文用不同措辞】主题是「今天到期」（独立成句要通顺），
  // 正文里嵌在「…事项{when}到期」中间，故用「今天」不重复"到期"。
  const subjectWhen = daysLeft <= 0 ? '今天到期' : `还剩 ${daysLeft} 天`;
  const when = daysLeft <= 0 ? '今天' : `还剩 ${daysLeft} 天`;
  if (options.detailed) {
    return {
      subject: `${NOTIFY_BRAND}：${kind} ${subjectWhen}`,
      text: `您在${NOTIFY_BRAND}登记的「${kind}」${when}到期。\n登录后可查看详情与下一步建议。\n若已处理完毕，可在应用内标记为已了结，不再收到本提醒。`,
    };
  }
  return {
    subject: `您有一项重要事项${subjectWhen}`,
    text: `您登记的一项重要事项${when}到期。\n请登录查看详情。\n若已处理完毕，可在应用内标记后不再收到提醒。`,
  };
}

/**
 * 守望订阅计费通知（余额不足 / 已暂停，spec v3 §2.2「绝不静默停盯」）。
 *
 * 【为什么走中性层、连"监控/守望/公司"都不提】收件人多半还在原公司上班。
 * 一封写着「某某公司的守望监控因欠费暂停」的邮件被工位旁人瞟见，暴露的是
 * **他在背地里盯着这家公司**——那和暴露"他在维权"一样不可逆。
 * 所以中性模式只说"一项服务"与"余额不足"这一点点判断紧急度的必要信息，
 * 具体是什么，让他登录进来看。
 *
 * 【为什么欠费也必须发、且暂停要再发一封】静默停盯是本产品最危险的失败模式：
 * 用户以为还在被守着，实际早已停了——等他发现，对方可能已经简易注销跑路。
 * 所以余额不足要通知、连续欠费到暂停时**再通知一次**，让"停了"这件事永远不静默发生。
 *
 * @param paused false=仍在盯但余额不足（催一下）；true=已连续欠费达上限、已暂停盯梢。
 */
export function watchBillingNotice(paused: boolean, options: CopyOptions = {}): MailCopy {
  if (options.detailed) {
    return paused
      ? {
          subject: `${NOTIFY_BRAND}：一项守望服务已暂停`,
          text: `您在${NOTIFY_BRAND}开启的一项守望服务因账户余额持续不足已暂停。\n登录充值后可随时重新开启，历史记录仍为您保留。`,
        }
      : {
          subject: `${NOTIFY_BRAND}：一项守望服务余额不足`,
          text: `您在${NOTIFY_BRAND}开启的一项守望服务账户余额不足，暂未能续期。\n请登录充值以免服务中断。`,
        };
  }
  return paused
    ? {
        subject: '您有一项服务已暂停',
        text: '您开启的一项服务因账户余额持续不足已暂停。\n请登录充值后重新开启，记录仍为您保留。',
      }
    : {
        subject: '您有一项服务余额不足',
        text: '您开启的一项服务账户余额不足，暂未能续期。\n请登录充值以免服务中断。',
      };
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
