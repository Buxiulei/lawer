// app/src/lib/notify/index.ts
// sms / email 薄客户端的对外出口（spec §3.2 跨模块只经导出接口）。
// wechat-pubacc 与 notify_log 幂等由 M4 的 deadline+notify 窗口补。
export { sendOtp, isMainlandPhone } from './sms';
export { sendMail, isValidEmail } from './email';
export { emailVerifyCode, smsVerifyTemplateParam } from './copy';
export type { CopyOptions, MailCopy } from './copy';
export type { MailTransport } from './email';
