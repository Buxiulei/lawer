// app/src/lib/lifecycle/account-cancel.ts
// 注销账号（协议 v0.2 五.9「注销账号」，附一第 7 项）。
//
// 【两步：二次确认 + 手机/邮箱验证码】注销把这个人名下的一切都推进删除流程，且不可撤销。
// 一步式的形态是：一次误点、或一次被借用的登录态，就把别人的全部证据与文书清掉。
// 第一步**零写入**（除了发一条码），回一份确认单与一串 confirm_token；
// 第二步要 confirm_token + 收到的验证码两样齐。
//
// 【验证码走自己的 purpose 桶】不复用登录那一桶：lib/db/otp.ts 把「取码按 purpose 隔离」
// 写成红线——共用一个桶意味着一条为登录发出的码能拿去注销账号。
//
// 【注销当场做四件事，第五件交给清理任务】
//   ① 名下全部案件按删除口径标删（连同收回免登录分享链接）；
//   ② 名下 api key 全部停用、OAuth 令牌全部吊销；
//   ③ 这个人的可识别信息当场抹掉（不等 30 天——那 30 天是给「彻底删除」留的，
//      不是给「还留着你的手机号」留的）。走 lib/lifecycle/identity-erase 那一个入口：
//      users 行只是四份副本里的第一份，另外三份（实名流水、护照材料密文、验证码行）
//      在那边一并处置，本文件不自己列清单——列两份就会漏（2026-09-07 复审）；
//   ④ 落 cancelled_at，它既是 30 日的起算点，也是凭据闸的判据（见 lib/auth/identity）。
//   ⑤ 到期硬删由 lib/jobs/retention-worker 做。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

import type { DomainFailure, Result } from '@/lib/cases';
import { hashLookup, decryptField } from '@/lib/crypto';
import * as store from '@/lib/db/cases';
import { gcOrphanFilesAmong } from '@/lib/db/filesGc';
import * as lifecycle from '@/lib/db/lifecycle';
import { fromSql, toSql } from '@/lib/db/time';
import { maskPhone } from '@/lib/auth/phone';
import { deleteEncFile } from '@/lib/evidence/files';
import { emailCancelCode, sendMail, sendOtp } from '@/lib/notify';
import type { MailCopy } from '@/lib/notify';

import { eraseUserIdentity } from './identity-erase';
import { RETENTION_DAYS, purgeAfter } from './retention';

/** 一条注销码最多错几次；与登录那一桶同一个数（错够了必须重新获取）。 */
const MAX_VERIFY_ATTEMPTS = 5;
/** 同一目标 60 秒内只发一条。与登录那一桶同一个数。 */
const RESEND_COOLDOWN_SECONDS = 60;

/** 验证码有效期分钟数。读的是与登录同一个环境变量——两处不同的话，页面上的倒计时会说谎。 */
function codeExpiryMinutes(): number {
  const parsed = Number(process.env.SMS_CODE_EXPIRY_MINUTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * 余额与套餐怎么处理，**这句话由运营配**（协议附二第 2 项仍在【待主理人确认】）。
 *
 * 【为什么是一句可配置的文案，而不是一段判断逻辑】退不退、怎么退还没有定论；
 * 在代码里先写一种处置，等于替主理人把这件事定了，而用户会照着这句话做决定。
 * 配了什么就说什么，没配就如实说「还没定，注销前请先联系我们问清楚」——
 * 一句「按平台规则处理」听起来像个答案，其实什么都没说。
 */
export const CANCEL_BALANCE_COPY_ENV = 'LAWER_CANCEL_BALANCE_COPY';

export const CANCEL_BALANCE_COPY_PENDING =
  '账户余额与已购套餐的处理方式**尚未定稿**（协议附二第 2 项，待主理人确认）。' +
  '如果你的账户里还有余额或还没用完的套餐，请在注销前先通过「设置 → 帮助与投诉」问清楚再决定——' +
  '注销不可撤销，我们不希望你在不知道这一项怎么算的情况下按下确认。';

export function cancelBalanceCopy(): string {
  const configured = process.env[CANCEL_BALANCE_COPY_ENV]?.trim();
  return configured || CANCEL_BALANCE_COPY_PENDING;
}

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 注销确认令牌：按账号身份派生，稳定、不可猜、不落库（同案件删除那一条的理由）。 */
export function cancelConfirmToken(userId: number): string {
  return hashLookup(`account_cancel:${userId}`).slice(0, 32);
}

export interface CancelChallenge {
  stage: 'challenge';
  confirm_token: string;
  /** 码发去了哪条通道 */
  channel: lifecycle.CancelCodeChannel;
  /** 已掩码的收件目标（手机号只留头尾，邮箱只留域名） */
  sent_to: string;
  expires_in_seconds: number;
  cases: number;
  removes: readonly string[];
  keeps: readonly string[];
  balance_note: string;
  note: string;
}

export interface AccountCancelled {
  stage: 'cancelled';
  cancelled_at: string;
  purge_after: string;
  cases_deleted: number;
  shares_revoked: number;
  keys_disabled: number;
  oauth_tokens_revoked: number;
  balance_note: string;
  note: string;
}

export const CANCEL_REMOVES: readonly string[] = [
  '名下全部案件档案，以及它们的材料原件、对话、情绪与危机记录、时间线、文书与报告',
  '全部免登录分享链接（确认那一刻立即失效）',
  '全部 api key 与已授权的第三方助手（确认那一刻立即停用）',
  '手机号、邮箱、姓名与证件号，含实名核验流水与上传过的护照材料（确认那一刻立即抹除）',
];

export const CANCEL_KEEPS: readonly string[] = [
  '已经出具过的存证证明：证明文件、订单号、哈希与时间戳照旧可查',
  '支付记录与账目流水：法律要求留存，按法定期限保留',
];

export interface CancelDeps {
  sendSms?: (phone: string, code: string) => Promise<void>;
  sendEmail?: (to: string, copy: MailCopy) => Promise<void>;
  now?: Date;
  /** 注入验证码（判据用）。生产不传，走 CSPRNG。 */
  makeCode?: () => string;
  /** 删密文文件（护照材料）；不给走真 unlink。判据注入探针，不碰文件系统。 */
  deleteFromDisk?: (encPath: string) => void;
}

interface UserRow {
  id: number;
  phone_enc: string | null;
  email: string | null;
  notify_verbose: number;
}

/** 掩码邮箱：只露首字母与域名。发回给调用方的是「码去哪儿了」，不是那个地址本身。 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function generateCode(): string {
  // 与登录那一桶同法：CSPRNG、6 位、避开前导 0
  return String(crypto.randomInt(100000, 1000000));
}

export interface CancelAccountInput {
  db: Database;
  userId: number;
  /** 第一步不给；第二步把收到的 6 位码传回来 */
  code?: unknown;
  /** 第二步必须带上第一步回的那串 */
  confirmToken?: unknown;
}

/**
 * 注销账号。不带 code = 出确认单并发一条验证码（零删除）；带 code + confirm_token = 执行。
 */
export async function cancelAccount(
  input: CancelAccountInput,
  deps: CancelDeps = {},
): Promise<Result<CancelChallenge | AccountCancelled>> {
  const { db, userId } = input;
  const now = deps.now ?? new Date();
  const user = db
    .prepare('SELECT id, phone_enc, email, notify_verbose FROM users WHERE id = ?')
    .get(userId) as UserRow | undefined;
  if (!user) return fail(404, 'USER_NOT_FOUND', '用户不存在');

  // 通道：有手机号走短信，否则走邮箱。**两样都没有的账号不能在这条路上注销**——
  // 没有第二因子的注销等于只要一张登录态就能抹掉一个人的全部档案。
  const phone = user.phone_enc ? safeDecrypt(user.phone_enc) : null;
  const channel: lifecycle.CancelCodeChannel | null = phone ? 'sms' : user.email ? 'email' : null;
  if (!channel) {
    return fail(
      409,
      'CANCEL_CHANNEL_MISSING',
      '这个账号上既没有手机号也没有邮箱，没法把注销验证码发给你，本次没有做任何改动。' +
        '为什么：注销不可撤销，必须由收得到验证码的本人确认，不能只凭一张登录态。' +
        '怎么办：先在设置页补绑手机号或邮箱，再来注销；绑不上的话请走「设置 → 帮助与投诉」。',
    );
  }
  const target = channel === 'sms' ? hashLookup(phone as string) : (user.email as string);
  const token = cancelConfirmToken(userId);
  const givenCode = typeof input.code === 'string' ? input.code.trim() : '';

  // ── 第一步：出确认单 + 发码。零删除。 ──
  if (!givenCode) {
    const cooldownFrom = toSql(new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000));
    if (lifecycle.countCancelCodesSince(db, channel, target, cooldownFrom) > 0) {
      return fail(429, 'RATE_LIMITED', '刚发过一条注销验证码，60 秒后再试。本次没有做任何改动。');
    }
    const minutes = codeExpiryMinutes();
    const code = (deps.makeCode ?? generateCode)();
    const codeId = lifecycle.insertCancelCode(db, {
      channel,
      target,
      code,
      expiresAt: toSql(new Date(now.getTime() + minutes * 60 * 1000)),
      createdAt: toSql(now),
    });
    try {
      if (channel === 'sms') await (deps.sendSms ?? sendOtp)(phone as string, code);
      else {
        await (deps.sendEmail ?? sendMail)(
          user.email as string,
          emailCancelCode(code, minutes, { detailed: user.notify_verbose === 1 }),
        );
      }
    } catch (err) {
      // 没发出去 = 这次不算数：撤掉那一行，冷却回到发之前（同登录那一桶的 F-204 口径）。
      lifecycle.deleteCancelCode(db, channel, codeId);
      return fail(
        502,
        'CODE_SEND_FAILED',
        `注销验证码没能发出去：${err instanceof Error ? err.message : String(err)}。本次没有做任何改动。` +
          '怎么办：稍后再点一次；一直发不出去请走「设置 → 帮助与投诉」。',
      );
    }
    return {
      ok: true,
      stage: 'challenge',
      confirm_token: token,
      channel,
      sent_to: channel === 'sms' ? maskPhone(phone as string) : maskEmail(user.email as string),
      expires_in_seconds: minutes * 60,
      cases: store.listCasesByUser(db, userId).length,
      removes: CANCEL_REMOVES,
      keeps: CANCEL_KEEPS,
      balance_note: cancelBalanceCopy(),
      note:
        '**本次没有注销任何东西**，只是把验证码发了出去。' +
        '把 removes、keeps 与 balance_note 三样逐条念给用户听，确认之后再带上 confirm_token 与收到的验证码调一次。' +
        `注销不可撤销：确认后档案立即从所有页面消失，${RETENTION_DAYS} 日后彻底删除。`,
    };
  }

  // ── 第二步：核对 → 执行 ──
  if ((typeof input.confirmToken === 'string' ? input.confirmToken.trim() : '') !== token) {
    return fail(
      400,
      'INVALID_CONFIRM_TOKEN',
      'confirm_token 与这个账号对不上，本次没有做任何改动。' +
        '为什么：注销要两样齐——第一步回的那串令牌，加上发到你手机/邮箱的验证码。' +
        '怎么办：不带 code 再调一次拿回确认单与新的验证码，把令牌原样传回来。',
    );
  }

  const row = lifecycle.latestCancelCode(db, channel, target);
  const stateFailure = checkCodeState(row, now);
  if (stateFailure) return stateFailure;
  if (row!.code !== givenCode) {
    lifecycle.bumpCancelCodeAttempts(db, channel, row!.id);
    if (row!.attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取注销验证码。本次没有做任何改动。');
    }
    return fail(400, 'OTP_INVALID', '验证码错误，请检查。本次没有做任何改动。');
  }

  const nowStr = toSql(now);
  const done = db.transaction(() => {
    lifecycle.markCancelCodeUsed(db, channel, row!.id);
    const first = lifecycle.markUserCancelled(db, userId, nowStr);
    let cases = 0;
    let shares = 0;
    // **含已软删的那些**：已经删过的案子的 deleted_at 不改写（markCaseDeleted 只改 NULL 的那些），
    // 但它们仍然要被数进来，否则回包里的"删了几个案子"会漏掉用户先删后注销的那几个。
    for (const c of store.listCasesByUserIncludingDeleted(db, userId)) {
      if (lifecycle.markCaseDeleted(db, c.id, nowStr)) cases += 1;
      shares += lifecycle.revokeCaseShares(db, c.id, nowStr);
    }
    const keys = lifecycle.disableAllApiKeys(db, userId);
    const tokens = lifecycle.revokeAllOauthTokens(db, userId, nowStr);
    // 抹字段排在最后：上面几步里有一步需要 phone_hash（发码那一桶按它取行），
    // 抹在前面的话第二次调用会因为找不到目标而报一个与真实原因无关的错。
    const erased = eraseUserIdentity(db, userId);
    return { first, cases, shares, keys, tokens, erased };
  })();

  // 护照材料的密文文件：**事务提交之后**才收。回收器自带事务，嵌进上面那个事务里
  // better-sqlite3 会当场拒绝；而判据仍是「无人引用」那一份，不是「这个人的就删」。
  // 这一步失败不该把一次已经做成的注销翻成失败——库里那几行已经没有任何指向它的引用了。
  try {
    gcOrphanFilesAmong(db, done.erased.released_file_ids, {
      deleteFromDisk: deps.deleteFromDisk ?? deleteEncFile,
    });
  } catch (err) {
    console.warn(`[cancel] 实名材料密文没收干净（库行已抹）：${(err as Error).message}`);
  }

  const after = lifecycle.findUserLifecycle(db, userId);
  const cancelledAt = after?.cancelled_at ?? nowStr;
  return {
    ok: true,
    stage: 'cancelled',
    cancelled_at: cancelledAt,
    purge_after: toSql(purgeAfter(done.first ? now : fromSql(cancelledAt))),
    cases_deleted: done.cases,
    shares_revoked: done.shares,
    keys_disabled: done.keys,
    oauth_tokens_revoked: done.tokens,
    balance_note: cancelBalanceCopy(),
    note:
      '已注销。手机号、邮箱、姓名与证件号已经抹掉，全部凭据已停用，名下案件已进入删除流程，' +
      `${RETENTION_DAYS} 日后彻底删除。已出具的存证证明与支付记录按 keeps 那份清单保留。` +
      '这一步不可撤销：这个账号的登录方式已经不存在了，重新使用请另行注册。',
  };
}

/** 密文解不开时按「没有手机号」处理，不把一个内部异常抛到注销这条路上。 */
function safeDecrypt(enc: string): string | null {
  try {
    return decryptField(enc);
  } catch {
    return null;
  }
}

/** 一条验证码在比对前的状态校验：不存在 / 已用 / 过期 / 已锁（与登录那一桶同口径）。 */
function checkCodeState(row: lifecycle.CancelCodeRow | undefined, now: Date): DomainFailure | null {
  if (!row) return fail(400, 'OTP_NOT_FOUND', '请先获取注销验证码。本次没有做任何改动。');
  if (row.used) return fail(400, 'OTP_EXPIRED', '验证码已使用，请重新获取。本次没有做任何改动。');
  if (fromSql(row.expires_at).getTime() <= now.getTime()) {
    return fail(400, 'OTP_EXPIRED', '验证码已过期，请重新获取。本次没有做任何改动。');
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return fail(429, 'OTP_LOCKED', '尝试次数过多，请重新获取验证码。本次没有做任何改动。');
  }
  return null;
}
