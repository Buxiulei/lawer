// app/src/lib/auth/otp.ts
// 手机 OTP + 邮箱验证码的全部业务逻辑。
//
// 【登录是单因素，注册才是双因素】老用户回来登录，手机与邮箱**任选一条**收码即可进站；
// 只有「验手机时发现这个号还没账号」＝新用户注册，才追加一步邮箱验证把账号补全。
// 所以邮箱那两个函数收的 userId 是可空的：带 token = 注册补全（给刚建的号绑邮箱），
// 不带 token = 邮箱通道登录（只认已经验证过、且确实属于某账号的邮箱，见 resolveEmailTarget；
// 不认识的邮箱不当场拒绝，而是走完与已注册同形的一整条路，接口不泄露注册状态）。
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
import { emailNotRegistered, emailVerifyCode, isValidEmail, sendMail, sendOtp } from '@/lib/notify';
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
/** 邮箱注册/登录的结果。isNewUser=true 表示这次调用现建的号（前端可据此决定要不要展示新手引导） */
export type EmailRegisterResult =
  | { ok: true; token: string; isNewUser: boolean; onboarding?: Onboarding }
  | AuthFailure;

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
 *
 * needEmail=true 表示这个账号的注册还没走完（邮箱没验过），前端应接着走邮箱那一步；
 * 已经走完的账号回来登录恒为 false——**登录只验这一条通道，不再要第二个因子**。
 * 注册仍要手机 + 邮箱两样齐（spec §8）：邮箱是换号找回与文书送达的唯一落点，
 * 建号时不收，用户丢了手机号就再也回不来。这里不按「是不是这次刚建的号」判，
 * 而按「邮箱验过没有」判：否则中途放弃邮箱那一步的人，下次登录就永久绕过了它。
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
 * resolveEmailTarget 的产物：这次邮箱操作落在哪个账号上，以及要不要吃 IP 配额。
 * user 为 null ＝ 匿名撞上一个名下没有账号的邮箱——**不在这里拒绝**，理由见 resolveEmailTarget。
 */
type EmailTarget = { ok: true; user: store.UserRow | null; knownUser: boolean } | AuthFailure;

/**
 * 邮箱通道的身份归属，发码与验码**共用这一处**判定——分开写两遍，日后只改一处就是个洞。
 *
 * - userId 非空（带 token）＝**注册补全**：手机验证刚建的号来绑邮箱。邮箱若属别人 → EMAIL_TAKEN。
 * - userId 为空（不带 token）＝**邮箱通道登录**：只认「已经验证过、且确实属于某个账号」的邮箱；
 *   不认识的邮箱返回 user=null，由调用方走完与已注册**同形**的那条路（见下）。
 *
 * 匿名这条不是放宽鉴权：落在哪个账号完全由邮箱本身决定，调用方指定不了；
 * 通行凭据仍是「一条发到该邮箱的六位码」，60s 冷却 / 10 次每日 / 五次锁定 / 一次性全额生效；
 * 且匿名路径一个字都不往 users 写（见 verifyEmailCode），拿不走也改不动别人的账号。
 * 强度与手机通道等价——那边同样是「拿到发往该号码的码即可换 token」。
 *
 * 【为什么不认识的邮箱也不当场拒绝】这里原本回 404 EMAIL_NOT_REGISTERED，
 * 而且是在任何限流之前回的——那就是一个零成本的**注册状态探针**：拿任意邮箱打一次接口，
 * 就能问出「这个人是不是我们的用户」。对本站用户来说这不是一般的隐私：
 * 名单本身就说明这些人正在维权。手机通道刻意不泄露这件事（陌生号码照发照收），
 * 邮箱通道不该自己开这个口，所以**对齐手机通道**：配额照吃、码照落库、响应与已注册的逐字段同形，
 * 只有真正收信的那个人（也只有他）会在信里看到「这个邮箱名下还没有账号」。
 * 打错字的用户在登录页上也有一句常驻提示，不必靠错误码去问。
 */
function resolveEmailTarget(
  db: Database,
  userId: number | null,
  owner: store.UserRow | undefined,
): EmailTarget {
  if (userId === null) {
    if (!owner?.email_verified_at) return { ok: true, user: null, knownUser: false };
    return { ok: true, user: owner, knownUser: true };
  }
  const user = store.findUserById(db, userId);
  if (!user) return fail(401, 'UNAUTHORIZED', '登录状态已失效，请重新验证手机号');
  if (owner && owner.id !== userId) {
    return fail(409, 'EMAIL_TAKEN', '该邮箱已被其他账号绑定');
  }
  // 已经是本人验证过的邮箱 = 回来重验，不吃 IP 配额（换绑新邮箱照旧计数）。
  // 上面的 EMAIL_TAKEN 已挡掉 owner 是别人的情形，走到这里 owner 必是 userId 本人。
  return { ok: true, user, knownUser: Boolean(owner?.email_verified_at) };
}

/**
 * 发送邮箱验证码。userId 由路由从 Authorization 头解析：
 * 有效 token → 注册补全；根本没带头 → 邮箱通道登录；带了坏 token → 路由已回 401，走不到这里。
 */
export async function sendEmailCode(
  db: Database,
  input: { userId: number | null; email: string; ip: string },
  deps: OtpDeps = {},
): Promise<SendResult> {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');

  const target = resolveEmailTarget(db, input.userId, store.findUserByEmail(db, email));
  if (!target.ok) return target;
  const user = target.user;

  const quotaFailure = checkSendQuota(db, input.ip, now, target.knownUser, (since) =>
    store.countEmailCodesSince(db, email, since),
  );
  if (quotaFailure) return quotaFailure;

  const minutes = codeExpiryMinutes();
  const code = generateCode();
  // 陌生邮箱（user === null）也照样落这一行：不落的话 /verify 那边就会分叉成
  // 「没有码可比」与「码错了」两种回答，注册状态探针换个接口又回来了。
  store.insertEmailCode(db, {
    email,
    code,
    purpose: store.EMAIL_PURPOSE.verify,
    expiresAt: toSql(new Date(now.getTime() + minutes * 60 * 1000)),
    createdAt: toSql(now),
  });

  // 详细文案只在用户自己开了 notify_verbose 时才用（默认 0 = 中性），见 lib/notify/copy.ts
  // 陌生邮箱收到的是引导信而不是码：接口对谁都不说注册状态，只有邮箱的主人在信里看得到。
  const copy =
    user === null
      ? emailNotRegistered()
      : emailVerifyCode(code, minutes, { detailed: user.notify_verbose === 1 });
  try {
    await (deps.sendEmail ?? ((to, c) => sendMail(to, c)))(email, copy);
  } catch {
    return fail(502, 'EMAIL_SEND_FAILED', '邮件发送失败，请稍后重试');
  }

  return { ok: true, ttlSeconds: minutes * 60, retryAfter: RESEND_COOLDOWN_SECONDS };
}

/**
 * 手机 + 邮箱双验证齐了（= 注册完成，spec §8）就自动开通默认案件。
 *
 * 建案失败不许阻断登录：账号已经建好、验证码也用掉了，这时候回一个错误只会把用户
 * 卡在登录页反复重试。记日志、返回 undefined，前端照常进站，用户自己建案也走得通。
 * api key 不在这里发——那是用户主动去 /api/v1/keys 领的东西，不该替他决定（spec D4）。
 */
function provisionOnRegistered(db: Database, userId: number): Onboarding | undefined {
  const user = store.findUserById(db, userId);
  if (!user?.phone_verified_at || !user.email_verified_at) return undefined;
  return provisionDefaultCase(db, userId);
}

/** 上面那段「建案失败不许阻断登录」的实现体；邮箱注册那条路径也用它，判据不同、兜底相同。 */
function provisionDefaultCase(db: Database, userId: number): Onboarding | undefined {
  try {
    return ensureDefaultCase(db, userId);
  } catch (err) {
    console.error('[auth] 注册自动建案失败（不阻断登录）', { userId, err });
    return undefined;
  }
}

/**
 * 校验邮箱验证码，换发一个新 token。
 * 注册补全（带 token）时把邮箱写进 users 并标记已验证；邮箱通道登录（不带）时只发 token，
 * 一个字都不写库——那个邮箱本来就已经验证过、也已经属于这个账号，没有任何东西要改。
 */
export function verifyEmailCode(
  db: Database,
  input: { userId: number | null; email: string; code: string },
  deps: OtpDeps = {},
): EmailVerifyResult {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');
  if (!isSixDigits(input.code)) return fail(400, 'OTP_INVALID', '验证码格式不正确');

  const target = resolveEmailTarget(db, input.userId, store.findUserByEmail(db, email));
  if (!target.ok) return target;
  const user = target.user;

  const row = store.latestEmailCode(db, email, store.EMAIL_PURPOSE.verify);
  const stateFailure = checkCodeState(row, now);
  if (stateFailure) return stateFailure;

  const code = input.code.trim();
  // user === null ＝ 匿名撞上一个名下没有账号的邮箱：那封信里根本没有码，所以**任何码都是错的**，
  // 且走的是与「码错了」完全相同的一条路（记一次尝试、错五次锁定），响应形状分不出两者。
  if (user === null || row!.code !== code) {
    store.bumpEmailCodeAttempts(db, row!.id);
    if (row!.attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码');
    }
    return fail(400, 'OTP_INVALID', '验证码错误，请检查');
  }

  const userId = user.id;
  store.markEmailCodeUsed(db, row!.id);
  if (input.userId !== null) store.setUserEmailVerified(db, userId, email, toSql(now));

  const onboarding = provisionOnRegistered(db, userId);
  return {
    ok: true,
    token: signToken(userId, now),
    ...(onboarding ? { onboarding } : {}),
  };
}

// ========== 邮箱注册（无手机号） ==========
//
// 与上面「邮箱验证码」那一节的区别不是实现细节，是**闸门语义**：
//   sendEmailCode / verifyEmailCode  —— 已登录的人给账号补绑邮箱，路由要 Bearer，
//                                       用 purpose='verify' 的码。
//   sendEmailRegisterCode / verifyEmailRegisterCode —— 匿名开户/登录，路由不要凭据，
//                                       用 purpose='register' 的码。
// 两桶的码互不通用（见 lib/db/otp.ts 的 EMAIL_PURPOSE），但**限流按邮箱聚合**，
// 所以多开一条路由不会给同一个信箱多一倍的额度。
//
// 【这条路径的鉴权强度】与手机那条完全对称，一项不减：CSPRNG 6 位码、5 分钟过期、
// 单次可用、错 5 次锁死、60 秒冷却、10 次/24h、新地址吃 IP 配额。
// 变的是「凭哪种占有证明开户」（信箱 vs 手机），不是「证明得多严」。

/**
 * 发邮箱注册验证码。**匿名调用**，不需要任何凭据。
 *
 * 存量已验证邮箱免 IP 配额（= 老用户回来登录），理由同 sendPhoneCode 的 knownUser：
 * 一家公司几百人共用一个 NAT 出口，老用户不该被同事的注册量挤掉。
 * 这不开口子——按邮箱的 60s 冷却与 10 次/日对每一次发码照旧全额生效。
 *
 * 响应形状与「该邮箱是否已注册」无关（都是 {ok, ttlSeconds, retryAfter}），
 * 不给攻击者一个查「这个地址在不在库里」的接口。
 */
export async function sendEmailRegisterCode(
  db: Database,
  input: { email: string; ip: string },
  deps: OtpDeps = {},
): Promise<SendResult> {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');

  const owner = store.findUserByEmail(db, email);
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
    purpose: store.EMAIL_PURPOSE.register,
    expiresAt: toSql(new Date(now.getTime() + minutes * 60 * 1000)),
    createdAt: toSql(now),
  });

  // 匿名请求没有「用户偏好」可读，一律用中性文案（notify_verbose 的默认值也是它）：
  // 收件人可能还不是我们的用户，这封信里不该出现任何案情线索。
  const copy = emailVerifyCode(code, minutes);
  try {
    await (deps.sendEmail ?? ((to, c) => sendMail(to, c)))(email, copy);
  } catch {
    return fail(502, 'EMAIL_SEND_FAILED', '邮件发送失败，请稍后重试');
  }

  return { ok: true, ttlSeconds: minutes * 60, retryAfter: RESEND_COOLDOWN_SECONDS };
}

/**
 * 校验邮箱注册验证码：查无此邮箱则建号（无手机号），有则直接登录。
 *
 * 【建号与注册赠送必须同生同死】理由与代价见 verifyPhoneCode 里那段长注释——
 * 没有赠送的新账号余额为 0，第一个计费动作就被 gongdaoGate 拦死，而账号看起来一切正常。
 * 所以这里用的是**同一套机制**：同一个事务 + 同一个 refId 形态 `reg-<uid>`（一人一次，
 * 唯一索引兜底），不是另写一份看起来差不多的逻辑。
 */
export function verifyEmailRegisterCode(
  db: Database,
  input: { email: string; code: string },
  deps: OtpDeps = {},
): EmailRegisterResult {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail(400, 'INVALID_EMAIL', '邮箱格式不正确');
  if (!isSixDigits(input.code)) return fail(400, 'OTP_INVALID', '验证码格式不正确');

  const row = store.latestEmailCode(db, email, store.EMAIL_PURPOSE.register);
  const stateFailure = checkCodeState(row, now);
  if (stateFailure) return stateFailure;

  const code = input.code.trim();
  if (row!.code !== code) {
    store.bumpEmailCodeAttempts(db, row!.id);
    // 第 5 次错直接锁定，不再放行下一次比对
    if (row!.attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码');
    }
    return fail(400, 'OTP_INVALID', '验证码错误，请检查');
  }

  store.markEmailCodeUsed(db, row!.id);

  let user = store.findUserByEmail(db, email);
  const isNewUser = !user;
  if (!user) {
    const createAccount = db.transaction(() => {
      const id = store.insertUserByEmail(db, { email, verifiedAt: toSql(now) });
      gongdaoGrant(id, REGISTER_GRANT_GONGDAO, GONGDAO_LEDGER_TYPE.register, `reg-${id}`, null, db);
      return id;
    });
    user = store.findUserById(db, createAccount())!;
  }

  const onboarding = provisionDefaultCase(db, user.id);
  return {
    ok: true,
    token: signToken(user.id, now),
    isNewUser,
    ...(onboarding ? { onboarding } : {}),
  };
}

// ───────────────── 留口不实现：邮箱账号后补手机号 ─────────────────
// 本单只做「邮箱+验证码即可开户」。这类账号 phone_enc / phone_hash 恒为 NULL，
// 于是短信期限提醒发不出去（lib/notify 的短信通道无收件人）、maskPhone 在 /api/v1/me
// 回 null——**这是已知且可接受的现状，不是 bug**。补手机号的路径按下面这份契约实现：
//
//   bindPhoneToAccount(db, { userId, phone, code }, deps): PhoneVerifyResult
//
// 实现时必须先定的四件事（本单不替它决定）：
//   1. 用哪一桶码：sms_codes 现在只有 purpose='login'，绑定要不要单开一桶
//      （同 EMAIL_PURPOSE 的理由：一条为登录发的码不该能拿去改别人账号的手机号）。
//   2. 号已被占时怎么办：目标手机号已属于另一个账号 → 409 还是走账号合并？
//      合并涉及案件、账本、api key 的归属，是产品决策不是技术决策。
//   3. 换绑还是只准补：已有手机号的账号能不能改，改了旧号还能不能登录。
//   4. 赠送不再发：refId `reg-<uid>` 已占，gongdaoGrant 的唯一索引天然挡住二次发放，
//      但要有测试把这条钉死，别让人以为「补了手机号 = 又完成一次注册」。


