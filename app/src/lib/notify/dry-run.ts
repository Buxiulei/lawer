// app/src/lib/notify/dry-run.ts
// 开发用的发送干跑开关：NOTIFY_DRY_RUN=1 时短信/邮件不真发，直接当成功返回。
// 验证码照常入库，开发者从 sms_codes / email_codes 表取码继续走流程，
// 不必配阿里云与 SMTP，也不会打扰真手机号。
//
// 【生产硬闸】NODE_ENV=production 时本开关一律无效，并打一条 error 日志。
// 理由：生产上"静默不发验证码"意味着所有人都登不进来，且现象是「显示发送成功、就是收不到」——
// 这种故障最难查。宁可因为缺凭证当场抛错，也不要悄悄不发。

/** 日志里不写验证码本身：见 email.ts「验证码进日志是事故」。码在库里，dev 自己查表取。 */
function mask(recipient: string): string {
  const s = (recipient ?? '').trim();
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(s.length - 6, 1))}${s.slice(-3)}`;
}

/**
 * 该不该跳过这次真实发送。
 * @param channel 通道名，只用于日志（如 '短信' / '邮件'）
 * @param recipient 收件人，日志里做掩码
 */
export function shouldDryRun(channel: string, recipient: string): boolean {
  if (process.env.NOTIFY_DRY_RUN !== '1') return false;

  if (process.env.NODE_ENV === 'production') {
    console.error(
      `[notify] ⛔ 生产环境忽略 NOTIFY_DRY_RUN=1，本次${channel}仍然真实发送。` +
        '这个开关只允许在开发环境使用，请立即从生产配置里删掉它。',
    );
    return false;
  }

  console.warn(
    `[notify] ⚠ NOTIFY_DRY_RUN=1：本次${channel}未真实发送（收件人 ${mask(recipient)}）。` +
      '验证码已照常入库，查 sms_codes / email_codes 表取码。',
  );
  return true;
}
