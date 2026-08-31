// app/src/lib/auth/otp.ts
// 手机 OTP + 邮箱验证码的全部业务逻辑（spec §8 auth：手机 OTP + 邮箱验证双必须）。
// 语义整块照搬 NBDpsy auth_sms.rs / auth_email.rs：
//   - 同一手机号/邮箱 60s 内只能再发一次（retry_after: 60）
//   - 同一手机号/邮箱 24h 内最多 10 次
//   - 同一 IP 24h 内最多 300 次（走库，且存量用户登录豁免，见 ip-quota.ts）
//   - 单条验证码最多错 5 次，第 5 次错直接锁定，必须重新获取
//   - 验证码 6 位数字，有效期 SMS_CODE_EXPIRY_MINUTES（默认 5 分钟）
// 路由只做「校验参数 → 调这里 → 把结果转成 JSON」，不许有第二处业务判断（spec §3.2）。
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { gongdaoGrant } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import { ensureDefaultCase } from '@/lib/cases';
import { encryptField, hashLookup } from '@/lib/crypto';
import { emailVerifyCode, isValidEmail, sendMail, sendOtp } from '@/lib/notify';
import type { MailCopy } from '@/lib/notify';
import * as store from '@/lib/db/otp';
import { fromSql, toSql } from '@/lib/db/time';
import { IP_QUOTA_MESSAGE, checkAndRecordIp } from './ip-quota';
import { signToken } from './jwt';
import { normalizePhone } from './phone';
import { classifySmsError } from './sms-errors';

const RESEND_COOLDOWN_SECONDS = 60;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_MAX_SENDS = 10;
const MAX_VERIFY_ATTEMPTS = 5;

/** 统一失败形态，路由直接映射成 {ok:false, error_code, message, retry_after?} + HTTP status */
export interface AuthFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
  retryAfter?: number;
}

/** 注册完成那一刻自动开通的东西，交给前端决定跳去哪个案件 */
export interface Onboarding {
  caseId: number;
  /** true = 这次刚建的；false = 本来就有案件，什么都没动 */
  isNew: boolean;
}

export type SendResult = { ok: true; ttlSeconds: number; retryAfter: number } | AuthFailure;
export type PhoneVerifyResult = { ok: true; token: string; needEmail: boolean } | AuthFailure;
export type EmailVerifyResult = { ok: true; token: string; onboarding?: Onboarding } | AuthFailure;

/** 外部副作用注入点：单测把短信/邮件换成假实现，绝不真发（真发既费钱又打扰真号） */
export interface OtpDeps {
  sendSms?: (phone: string, code: string) => Promise<void>;
  sendEmail?: (to: string, copy: MailCopy) => Promise<void>;
  now?: Date;
}

function fail(
  status: number,
  errorCode: string,
  message: string,
  retryAfter?: number,
): AuthFailure {
  return { ok: false, status, errorCode, message, retryAfter };
}

function codeExpiryMinutes(): number {
  const parsed = Number(process.env.SMS_CODE_EXPIRY_MINUTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/** 6 位数字，取 100000..999999 避开前导 0（与 NBDpsy 一致）；用 CSPRNG 而不是 Math.random */
function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** 邮箱归一化：去空白 + 转小写。入库、查表、限流三处必须用同一个产物。 */
function normalizeEmail(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * 三条发码限流的公共部分：IP → 60s 冷却 → 24h 上限。
 * 顺序照抄 NBDpsy：IP 计数在最前，所以 60s 内重复点也会消耗 IP 额度。
 *
 * knownUser=true 即「目标手机号/邮箱已经是验证过的存量用户」＝登录场景，此时**跳过 IP 这条**：
 * 一家公司几百人从同一个 NAT 出口上来，老用户回来登录不该被同事的注册量挤掉。
 * 这不开口子——按号码/邮箱的 60s 冷却与 10 次/日对每一次发码照旧全额生效，
 * 而豁免的前提本身就是「这个号码已经属于某个真实账号」，拿它灌不出新账号来。
 */
function checkSendQuota(
  db: Database,
  ip: string,
  now: Date,
  knownUser: boolean,
  countSince: (sinceIso: string) => number,
): AuthFailure | null {
  if (!knownUser && !checkAndRecordIp(db, ip, now)) {
    return fail(429, 'RATE_LIMITED', IP_QUOTA_MESSAGE, RESEND_COOLDOWN_SECONDS);
  }
  const cooldownFrom = toSql(new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000));
  if (countSince(cooldownFrom) > 0) {
    return fail(429, 'RATE_LIMITED', '发送过于频繁，60 秒后再试', RESEND_COOLDOWN_SECONDS);
  }
  const dayFrom = toSql(new Date(now.getTime() - DAILY_WINDOW_MS));
  if (countSince(dayFrom) >= DAILY_MAX_SENDS) {
    return fail(429, 'RATE_LIMITED', '今日发送次数已达上限，请明天再试');
  }
  return null;
}

/** 一条验证码在比对前的状态校验：不存在 / 已用 / 过期 / 已锁 */
function checkCodeState(row: store.OtpRow | undefined, now: Date): AuthFailure | null {
  if (!row) return fail(400, 'OTP_NOT_FOUND', '请先获取验证码');
  if (row.used) return fail(400, 'OTP_EXPIRED', '验证码已使用，请重新获取');
  if (fromSql(row.expires_at).getTime() <= now.getTime()) {
    return fail(400, 'OTP_EXPIRED', '验证码已过期，请重新获取');
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码');
  }
  return null;
}

function isSixDigits(code: string): boolean {
  return /^\d{6}$/.test((code ?? '').trim());
}

// ========== 手机 OTP ==========

/**
 * 发送手机验证码。
 * 验证码先入库再发短信：发失败也占掉一次 24h 额度，这样上游持续报错时不会被无限重试打爆。
 */
export async function sendPhoneCode(
  db: Database,
  input: { phone: string; ip: string },
  deps: OtpDeps = {},
): Promise<SendResult> {
  const now = deps.now ?? new Date();
  const phone = normalizePhone(input.phone);
  if (!phone) return fail(400, 'INVALID_PHONE', '手机号格式不正确');

  const phoneHash = hashLookup(phone);
  // 已验证过手机号的存量用户 = 登录，不吃 IP 配额（见 checkSendQuota 的 knownUser）
  const knownUser = Boolean(store.findUserByPhoneHash(db, phoneHash)?.phone_verified_at);
  const quotaFailure = checkSendQuota(db, input.ip, now, knownUser, (since) =>
    store.countSmsCodesSince(db, phoneHash, since),
  );
  if (quotaFailure) return quotaFailure;

  const minutes = codeExpiryMinutes();
  const code = generateCode();
  store.insertSmsCode(db, {
    phoneHash,
    code,
    expiresAt: toSql(new Date(now.getTime() + minutes * 60 * 1000)),
    createdAt: toSql(now),
  });

  try {
    await (deps.sendSms ?? ((p, c) => sendOtp(p, c)))(phone, code);
  } catch (err) {
    const classified = classifySmsError(err);
    return fail(classified.status, classified.errorCode, classified.message);
  }

  return { ok: true, ttlSeconds: minutes * 60, retryAfter: RESEND_COOLDOWN_SECONDS };
}

/**
 * 校验手机验证码，通过即登录（查无此号则建号）。
 * 返回 needEmail 表示这个账号还没验过邮箱——spec §8 要求手机 + 邮箱双验证才算注册完成。
 */
export function verifyPhoneCode(
  db: Database,
  input: { phone: string; code: string },
  deps: OtpDeps = {},
): PhoneVerifyResult {
  const now = deps.now ?? new Date();
  const phone = normalizePhone(input.phone);
  if (!phone) return fail(400, 'INVALID_PHONE', '手机号格式不正确');
  if (!isSixDigits(input.code)) return fail(400, 'OTP_INVALID', '验证码格式不正确');

  const phoneHash = hashLookup(phone);
  const row = store.latestSmsCode(db, phoneHash);
  const stateFailure = checkCodeState(row, now);
  if (stateFailure) return stateFailure;

  const code = input.code.trim();
  if (row!.code !== code) {
    store.bumpSmsCodeAttempts(db, row!.id);
    // 第 5 次错直接锁定，不再放行下一次比对
    if (row!.attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码');
    }
    return fail(400, 'OTP_INVALID', '验证码错误，请检查');
  }

  store.markSmsCodeUsed(db, row!.id);

  let user = store.findUserByPhoneHash(db, phoneHash);
  if (!user) {
    /**
     * 【建号与注册赠送必须同生同死】没有赠送的新账号余额为 0，而 `gongdaoGate` 的门槛是
     * 余额 ≥ 1 —— 它第一个计费动作就会被拦死。**一个建成了却用不了的账号，比建号失败更坏**：
     * 建号失败用户会重试，而这种账号看起来一切正常，人会以为是产品坏了。
     * （这不是假设：2026-08-28 产线上两个真实账号就都卡在这里，其中一个是负责人本人。）
     *
     * 所以包在同一个事务里：要么两件都成，要么一件都不成。
     * refId 用 `reg-<uid>`，天然一人一次；重试注册不会重复发放（唯一索引兜底）。
     */
    const createAccount = db.transaction(() => {
      const id = store.insertUser(db, {
        phoneEnc: encryptField(phone),
        phoneHash,
        verifiedAt: toSql(now),
      });
      gongdaoGrant(id, REGISTER_GRANT_GONGDAO, GONGDAO_LEDGER_TYPE.register, `reg-${id}`, null, db);
      return id;
    });
    user = store.findUserById(db, createAccount())!;
  }

  return { ok: true, token: signToken(user.id, now), needEmail: !user.email_verified_at };
}

// ========== 邮箱验证码 ==========

/**
 * 发送邮箱验证码。调用前路由必须已经校验过 JWT——邮箱验证是「已通过手机验证的用户补第二因子」，
 * 不是独立的注册入口，所以这里收的是 userId 而不是匿名请求。
 */
export async function sendEmailCode(
  db: Database,
  input: { userId: number; email: string; ip: string },
  deps: OtpDeps = {},
): Promise<SendResult> {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');

  const user = store.findUserById(db, input.userId);
  if (!user) return fail(401, 'UNAUTHORIZED', '登录状态已失效，请重新验证手机号');

  const owner = store.findUserByEmail(db, email);
  if (owner && owner.id !== input.userId) {
    return fail(409, 'EMAIL_TAKEN', '该邮箱已被其他账号绑定');
  }

  // 这个邮箱已经是本人验证过的邮箱 = 回来重验，不吃 IP 配额（换绑新邮箱照旧计数）。
  // 上面的 EMAIL_TAKEN 已经挡掉 owner 是别人的情形，走到这里 owner 必是 input.userId。
  const knownUser = Boolean(owner?.email_verified_at);
  const quotaFailure = checkSendQuota(db, input.ip, now, knownUser, (since) =>
    store.countEmailCodesSince(db, email, since),
  );
  if (quotaFailure) return quotaFailure;

  const minutes = codeExpiryMinutes();
  const code = generateCode();
  store.insertEmailCode(db, {
    email,
    code,
    expiresAt: toSql(new Date(now.getTime() + minutes * 60 * 1000)),
    createdAt: toSql(now),
  });

  // 详细文案只在用户自己开了 notify_verbose 时才用（默认 0 = 中性），见 lib/notify/copy.ts
  const copy = emailVerifyCode(code, minutes, { detailed: user.notify_verbose === 1 });
  try {
    await (deps.sendEmail ?? ((to, c) => sendMail(to, c)))(email, copy);
  } catch {
    return fail(502, 'EMAIL_SEND_FAILED', '邮件发送失败，请稍后重试');
  }

  return { ok: true, ttlSeconds: minutes * 60, retryAfter: RESEND_COOLDOWN_SECONDS };
}

/**
 * "注册完成"就自动开通默认案件。两条线各自的完成判据：
 *
 *  · 手机线 / 邮箱线：手机 + 邮箱双验证齐了（spec §8）。
 *  · Google 线：已绑 google_sub + 邮箱已验证。**Google 那边替我们验过这个邮箱**
 *    （id_token 的 email_verified 必须为布尔 true 才走得到这里，见 auth/google.ts），
 *    再逼他补一个手机号才给档案，就是让 Google 用户当二等公民——登得进去，
 *    却一进站就没有案件可用。故此处**不要求 phone_verified_at**。
 *
 * 建案失败不许阻断登录：账号已经建好、验证码也用掉了，这时候回一个错误只会把用户
 * 卡在登录页反复重试。记日志、返回 undefined，前端照常进站，用户自己建案也走得通。
 * api key 不在这里发——那是用户主动去 /api/v1/keys 领的东西，不该替他决定（spec D4）。
 *
 * 【这里是"注册完成"这条判据的唯一住址】Google 线（lib/auth/google.ts）登录成功后调的
 * 也是本函数，不自己再写一遍条件——上面那条 Google 分支正是加在这里而不是加在 google.ts。
 * 将来放宽成"任一验证通道齐备即算注册完成"时，改这一个函数，两条线同时生效——
 * 各写各的话，改完一处另一处会静默地停在旧规则上。
 */
export function provisionOnRegistered(db: Database, userId: number): Onboarding | undefined {
  const user = store.findUserById(db, userId);
  // 邮箱必须已验证是两条线的公共前提；第二个凭据手机或 Google 有一个就够
  if (!user?.email_verified_at) return undefined;
  if (!user.phone_verified_at && !user.google_sub) return undefined;
  try {
    return ensureDefaultCase(db, userId);
  } catch (err) {
    console.error('[auth] 注册自动建案失败（不阻断登录）', { userId, err });
    return undefined;
  }
}

/** 校验邮箱验证码，通过则把邮箱写进 users 并标记已验证，换发一个新 token */
export function verifyEmailCode(
  db: Database,
  input: { userId: number; email: string; code: string },
  deps: OtpDeps = {},
): EmailVerifyResult {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');
  if (!isSixDigits(input.code)) return fail(400, 'OTP_INVALID', '验证码格式不正确');

  const owner = store.findUserByEmail(db, email);
  if (owner && owner.id !== input.userId) {
    return fail(409, 'EMAIL_TAKEN', '该邮箱已被其他账号绑定');
  }

  const row = store.latestEmailCode(db, email);
  const stateFailure = checkCodeState(row, now);
  if (stateFailure) return stateFailure;

  const code = input.code.trim();
  if (row!.code !== code) {
    store.bumpEmailCodeAttempts(db, row!.id);
    if (row!.attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码');
    }
    return fail(400, 'OTP_INVALID', '验证码错误，请检查');
  }

  store.markEmailCodeUsed(db, row!.id);
  store.setUserEmailVerified(db, input.userId, email, toSql(now));

  const onboarding = provisionOnRegistered(db, input.userId);
  return {
    ok: true,
    token: signToken(input.userId, now),
    ...(onboarding ? { onboarding } : {}),
  };
}
