// app/src/lib/db/otp.ts
// sms_codes / email_codes / users 三张表的封装（spec §6：lib/db 是唯一 SQL 层）。
// 表结构由 migrate.ts（WS1）定义，本文件只负责读写，不建表。
//
// 所有函数第一个参数收 db 句柄，不自己拿单例：便于单测用 :memory: 库，
// 也让 lib/db/client.ts 的实现方式与本文件解耦。
import type { Database } from 'better-sqlite3';

/** sms_codes 目前只有一种用途；写入与查码都显式带上。 */
const SMS_PURPOSE = 'login';

/**
 * email_codes 有两种用途，**取码时必须按 purpose 隔离**：
 *   'verify'   已登录账号补绑/换绑邮箱（/auth/email/send|verify，要 Bearer）
 *   'register' 匿名的邮箱注册与登录（/auth/email/register/*，无凭据）
 *
 * 【为什么隔离】'register' 那条链路验完就发 token，等于凭这串码开户；
 * 'verify' 那条只是给已登录的人绑地址。两者若共用一个桶，一条为绑定发出的码
 * 就能拿去开户（反之亦然）——**同一串数字在两个语义完全不同的闸门上都好使**。
 * 隔离的代价是同一邮箱可能同时存在两条未过期的码，各自单次可用、5 分钟过期、
 * 错 5 次锁死，这个代价可以接受。
 */
export const EMAIL_PURPOSE = {
  verify: 'verify',
  register: 'register',
} as const;
export type EmailPurpose = (typeof EMAIL_PURPOSE)[keyof typeof EMAIL_PURPOSE];

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
  /** 绑定的 Google 账号标识（ID Token 的 sub）；NULL = 没绑过（见 lib/auth/google.ts） */
  google_sub: string | null;
}

const USER_COLUMNS =
  'id, phone_hash, email, email_verified_at, phone_verified_at, notify_verbose, auth_status, google_sub';

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

/**
 * 某邮箱在 sinceIso 之后收到的验证码条数（60s 冷却与 24h 上限都用它）。
 * 时间比较为何套 datetime()：见 countSmsCodesSince。
 *
 * 【**故意不按 purpose 过滤**】限流保护的是收件人的信箱，而信箱只有一个：
 * 按 purpose 分桶就等于同一个地址每天可以收 10+10 封、并且在两条路由之间交替点
 * 还能绕开 60 秒冷却。取码按 purpose 严格隔离，计数按邮箱聚合，两者不矛盾——
 * 一个防的是「码被挪用」，一个防的是「信箱被灌爆」。
 * 索引 idx_email_codes_email 建在 (email, id DESC) 上，不带 purpose，去掉这个条件不影响选择性。
 */
export function countEmailCodesSince(db: Database, email: string, sinceIso: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND datetime(created_at) > datetime(?)',
    )
    .get(email, sinceIso) as { n: number };
  return row.n;
}

/** purpose 必填、不给默认值：漏传会被类型系统当场拦下，而不是静默落进 'verify' 桶 */
export function insertEmailCode(
  db: Database,
  params: {
    email: string;
    code: string;
    purpose: EmailPurpose;
    expiresAt: string;
    createdAt: string;
  },
): void {
  db.prepare(
    'INSERT INTO email_codes (email, code, purpose, expires_at, used, attempts, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
  ).run(params.email, params.code, params.purpose, params.expiresAt, params.createdAt);
}

export function latestEmailCode(
  db: Database,
  email: string,
  purpose: EmailPurpose,
): OtpRow | undefined {
  return db
    .prepare(
      'SELECT id, code, attempts, expires_at, used FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    )
    .get(email, purpose) as OtpRow | undefined;
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

/**
 * 邮箱注册建号：只有邮箱，phone_enc / phone_hash 留 NULL。
 * users.phone_hash 的唯一索引是部分索引（WHERE phone_hash IS NOT NULL），
 * 所以多个「没手机号的账号」并存不会互相撞车；email 那条唯一索引照旧管住重复注册。
 *
 * 【留口不实现】这类账号后补手机号的路径（bindPhoneToAccount）本单不做，
 * 契约与待定项写在 lib/auth/otp.ts 文件末尾那段注释里，实现时照那里补。
 */
export function insertUserByEmail(
  db: Database,
  params: { email: string; verifiedAt: string },
): number {
  const info = db
    .prepare('INSERT INTO users (email, email_verified_at, created_at) VALUES (?, ?, ?)')
    .run(params.email, params.verifiedAt, params.verifiedAt);
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

// ========== users：Google 线（lib/auth/google.ts 的 SQL 面）==========

/** 按 google_sub 查账号。归并第一顺位——sub 命中就是同一个人，别的线索都不用看。 */
export function findUserByGoogleSub(db: Database, googleSub: string): UserRow | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`).get(googleSub) as
    | UserRow
    | undefined;
}

/**
 * 把 google_sub 绑到既有账号上，**仅当该行还没绑过**（WHERE google_sub IS NULL 守卫）。
 * 返回是否真的绑上了：false = 这一瞬间被别人抢先绑了，调用方必须回查再判，
 * 不能当成"绑成功"往下走——那会把 A 的 Google 账号记在 B 的档案上。
 *
 * 只写 google_sub 一列。**不回填 email**：调用方是按这个邮箱查到这一行的，
 * 而 email 与 email_verified_at 由 setUserEmailVerified 同时写入（邮箱非空 ⟺ 已验证），
 * 所以"这一行邮箱是空的"在这条路径上不存在，写了也是永不生效的一句。
 */
export function bindGoogleSub(
  db: Database,
  params: { userId: number; googleSub: string },
): boolean {
  const info = db
    .prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL')
    .run(params.googleSub, params.userId);
  return info.changes === 1;
}

/**
 * Google 线首次登录即建号。没有手机号——phone_enc / phone_hash 留 NULL，
 * uq_users_phone_hash 是部分索引（WHERE phone_hash IS NOT NULL），多行 NULL 不冲突。
 *
 * email_verified_at 直接写上：Google 的 ID Token 里 email_verified=true 就是「已验证」，
 * 不该再让用户收一遍验证码去证明一件 Google 已经证明过的事。
 */
export function insertGoogleUser(
  db: Database,
  params: { email: string; googleSub: string; verifiedAt: string },
): number {
  const info = db
    .prepare(
      'INSERT INTO users (email, email_verified_at, google_sub, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(params.email, params.verifiedAt, params.googleSub, params.verifiedAt);
  return Number(info.lastInsertRowid);
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
