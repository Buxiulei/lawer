// app/src/lib/db/otp.ts
// sms_codes / email_codes / users 三张表的封装（spec §6：lib/db 是唯一 SQL 层）。
// 表结构由 migrate.ts（WS1）定义，本文件只负责读写，不建表。
//
// 所有函数第一个参数收 db 句柄，不自己拿单例：便于单测用 :memory: 库，
// 也让 lib/db/client.ts 的实现方式与本文件解耦。
import type { Database } from 'better-sqlite3';

/** 两张 OTP 表都带 purpose 列，各自只有一种用途；写入与统计都显式带上，
 *  免得将来多出一种 purpose 时限流把两种码混在一起算。 */
const SMS_PURPOSE = 'login';
const EMAIL_PURPOSE = 'verify';

/** OTP 一行的读取形态（sms_codes 与 email_codes 结构一致） */
export interface OtpRow {
  id: number;
  code: string;
  attempts: number;
  expires_at: string;
  /** 0/1，SQLite 无布尔型 */
  used: number;
}

/** users 表里认证流程用得到的列 */
export interface UserRow {
  id: number;
  phone_hash: string | null;
  email: string | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  /** 0=中性文案，1=用户明确开启的详细文案（见 lib/notify/copy.ts 的产品约束） */
  notify_verbose: number;
  /** 未认证 | 待审 | 已实名。固化出证等强身份动作的闸门（见 lib/auth/guard.ts requireRealname） */
  auth_status: string;
}

const USER_COLUMNS =
  'id, phone_hash, email, email_verified_at, phone_verified_at, notify_verbose, auth_status';

// ========== sms_codes ==========

/**
 * 统计某手机号在 sinceIso 之后发出的验证码条数（60s / 24h 两条限流都用它）。
 *
 * 两边都套 datetime()：本模块写入的是 ISO8601（"…T10:00:00.000Z"），而建表默认值是
 * datetime('now')（"… 10:00:00"）。裸字符串比较下空格(0x20) < 'T'，同一时刻的默认格式行
 * 会被排到 ISO 行之前、被当成"很久以前"，从而绕过 60 秒冷却。datetime() 会把两种格式
 * 归一成同一canonical 串，谁写的行都算得对。
 * 过滤先走 phone_hash（有索引），每号每天最多十几行，包一层函数的代价可以忽略。
 */
export function countSmsCodesSince(db: Database, phoneHash: string, sinceIso: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM sms_codes WHERE phone_hash = ? AND purpose = ? AND datetime(created_at) > datetime(?)',
    )
    .get(phoneHash, SMS_PURPOSE, sinceIso) as { n: number };
  return row.n;
}

/** 每次发码插新行而不是 UPSERT：限流统计与审计都依赖历史行（照抄 NBDpsy） */
export function insertSmsCode(
  db: Database,
  params: { phoneHash: string; code: string; expiresAt: string; createdAt: string },
): void {
  db.prepare(
    'INSERT INTO sms_codes (phone_hash, code, purpose, expires_at, used, attempts, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
  ).run(params.phoneHash, params.code, SMS_PURPOSE, params.expiresAt, params.createdAt);
}

/** 取该手机号最新一条验证码；旧码不再可用，等价于发新码即作废旧码 */
export function latestSmsCode(db: Database, phoneHash: string): OtpRow | undefined {
  return db
    .prepare(
      'SELECT id, code, attempts, expires_at, used FROM sms_codes WHERE phone_hash = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    )
    .get(phoneHash, SMS_PURPOSE) as OtpRow | undefined;
}

export function bumpSmsCodeAttempts(db: Database, id: number): void {
  db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function markSmsCodeUsed(db: Database, id: number): void {
  db.prepare('UPDATE sms_codes SET used = 1 WHERE id = ?').run(id);
}

// ========== email_codes ==========

/** 时间比较为何套 datetime()：见 countSmsCodesSince */
export function countEmailCodesSince(db: Database, email: string, sinceIso: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND purpose = ? AND datetime(created_at) > datetime(?)',
    )
    .get(email, EMAIL_PURPOSE, sinceIso) as { n: number };
  return row.n;
}

export function insertEmailCode(
  db: Database,
  params: { email: string; code: string; expiresAt: string; createdAt: string },
): void {
  db.prepare(
    'INSERT INTO email_codes (email, code, purpose, expires_at, used, attempts, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
  ).run(params.email, params.code, EMAIL_PURPOSE, params.expiresAt, params.createdAt);
}

export function latestEmailCode(db: Database, email: string): OtpRow | undefined {
  return db
    .prepare(
      'SELECT id, code, attempts, expires_at, used FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    )
    .get(email, EMAIL_PURPOSE) as OtpRow | undefined;
}

export function bumpEmailCodeAttempts(db: Database, id: number): void {
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function markEmailCodeUsed(db: Database, id: number): void {
  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(id);
}

// ========== users ==========

export function findUserByPhoneHash(db: Database, phoneHash: string): UserRow | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE phone_hash = ?`).get(phoneHash) as
    | UserRow
    | undefined;
}

export function findUserById(db: Database, id: number): UserRow | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

/** 邮箱占用检查：命中且不是本人，说明这个邮箱已经绑在别的账号上 */
export function findUserByEmail(db: Database, email: string): UserRow | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(email) as
    | UserRow
    | undefined;
}

/** 首次通过手机验证即建号；auth_status 保持默认「未认证」，实人认证在 M2 */
export function insertUser(
  db: Database,
  params: { phoneEnc: string; phoneHash: string; verifiedAt: string },
): number {
  const info = db
    .prepare(
      'INSERT INTO users (phone_enc, phone_hash, phone_verified_at, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(params.phoneEnc, params.phoneHash, params.verifiedAt, params.verifiedAt);
  return Number(info.lastInsertRowid);
}

/** 实名闸门状态。取值归 lib/auth/realname（AUTH_STATUS），本层只当字符串存。 */
export function setUserAuthStatus(db: Database, id: number, authStatus: string): void {
  db.prepare('UPDATE users SET auth_status = ? WHERE id = ?').run(authStatus, id);
}

/**
 * 实名通过后回填姓名与证件号。两列都是密文（lib/crypto 加密后传进来），本层不认识明文。
 * 与 auth_status 同一条 UPDATE：状态说"已实名"而两列还是空的，这种中间态不该存在。
 */
export function setUserRealname(
  db: Database,
  id: number,
  params: { realNameEnc: string; idCardEnc: string; authStatus: string; certType?: string },
): void {
  // certType 与 idCardEnc 必须同一条 UPDATE 写：掩码规则依赖它，
  // 「证件号已经换成护照、cert_type 还是空」这种中间态会让存证书按最保守规则遮
  // ——那不至于泄露，但也不该存在。
  db.prepare(
    'UPDATE users SET real_name_enc = ?, id_card_enc = ?, auth_status = ?, cert_type = COALESCE(?, cert_type) WHERE id = ?',
  ).run(
    params.realNameEnc,
    params.idCardEnc,
    params.authStatus,
    params.certType ?? null,
    id,
  );
}

/** 邮箱在验证通过的那一刻才写进 users，避免未验证的邮箱先占住 uq_users_email */
export function setUserEmailVerified(
  db: Database,
  id: number,
  email: string,
  verifiedAt: string,
): void {
  db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').run(
    email,
    verifiedAt,
    id,
  );
}
