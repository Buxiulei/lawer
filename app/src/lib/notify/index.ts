// app/src/lib/notify/index.ts
// sms / email 薄客户端的对外出口（spec §3.2 跨模块只经导出接口）。
// wechat-pubacc 与 notify_log 幂等由 M4 的 deadline+notify 窗口补。
export { sendOtp, isMainlandPhone } from './sms';
// 阿里云 RPC 签名：短信与实人认证（lib/auth/realname.ts）共用同一套协议，故在此对外开放
export { buildSignedRpcUrl } from './aliyun-rpc';
export type { FetchImpl, SignatureMethod } from './aliyun-rpc';
export { sendMail, isValidEmail } from './email';
export { emailNotRegistered, emailVerifyCode, smsVerifyTemplateParam, NOTIFY_BRAND } from './copy';
export { shouldDryRun } from './dry-run';
// 邮件版式的唯一入口（见 mail-template.ts 顶部）：要预览/落样例的从这里取，不要另拼一份
export { renderMail, BURGUNDY } from './mail-template';
export type { CopyOptions, MailCopy, MailBlock } from './copy';
export type { MailTransport } from './email';
export type { RenderedMail } from './mail-template';
