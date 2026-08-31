// app/src/lib/auth/index.ts
// 认证模块对外出口（spec §3.2 跨模块只经导出接口）。
export { sendPhoneCode, verifyPhoneCode, sendEmailCode, verifyEmailCode } from './otp';
export type {
  AuthFailure,
  SendResult,
  PhoneVerifyResult,
  EmailVerifyResult,
  OtpDeps,
  Onboarding,
} from './otp';
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
export { requireIdentity, requireWebSession, requireRealname, domainFailure, parseId } from './guard';
export type { GuardResult, GateResult } from './guard';
// Google 一键登录（OAuth 授权码流，GOOGLE_OAUTH_ENABLED 默认关）
export {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_STATE_COOKIE,
  buildAuthorizeUrl,
  clearStateCookieHeader,
  completeGoogleCallback,
  createOauthState,
  failureLandingUrl,
  isGoogleOauthEnabled,
  parseIdTokenFromTokenEndpoint,
  readCookie,
  readGoogleConfig,
  resolveGoogleUser,
  stateCookieHeader,
  statesMatch,
  successLandingUrl,
} from './google';
export type {
  GoogleCallbackInput,
  GoogleCallbackResult,
  GoogleConfig,
  GoogleDeps,
  GoogleIdentity,
  ResolvedGoogleUser,
} from './google';
// 实人认证（阿里云 CloudAuth H5 活体）
export { startRealname, refreshRealnameStatus, AUTH_STATUS, VERIFICATION_STATUS } from './realname';
export type { StartRealnameResult, RealnameStatusResult, RealnameDeps } from './realname';
