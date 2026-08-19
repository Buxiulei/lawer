// app/src/lib/auth/index.ts
// 认证模块对外出口（spec §3.2 跨模块只经导出接口）。
// 实人认证（CloudAuth）在 M2 接入，届时在本目录另开文件并从这里导出。
export { sendPhoneCode, verifyPhoneCode, sendEmailCode, verifyEmailCode } from './otp';
export type { AuthFailure, SendResult, PhoneVerifyResult, EmailVerifyResult, OtpDeps } from './otp';
export { signToken, verifyToken, verifyAuthHeader, TOKEN_TTL_SECONDS } from './jwt';
export type { TokenPayload } from './jwt';
export { normalizePhone, maskPhone } from './phone';
export { extractClientIp } from './ip-quota';
// api key（agent 直连凭据）与 Bearer 双态身份解析
export {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  parseScopes,
  normalizeRequestedScopes,
  ALL_SCOPES,
  DEFAULT_SCOPES,
} from './api-key';
export type { Scope } from './api-key';
export { resolveIdentity, extractBearer, hasScope } from './identity';
export type { Identity } from './identity';
export { requireIdentity, requireWebSession, domainFailure, parseId } from './guard';
