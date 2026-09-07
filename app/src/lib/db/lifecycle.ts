// app/src/lib/db/lifecycle.ts
// 数据生命周期的 SQL 层（spec §6：lib/db 是唯一 SQL 层）：案件软删与到期硬删、账号注销与
// 到期清理、同意台账、转介删除请求。表结构见 migrate.ts 末尾那一段。
//
// 【本文件的每个「删」都是抢占式的】到期清理会由常驻任务反复扫到同一批行，所以删除与清理
// 一律写成带条件的一句 SQL，按 changes===1 判定「这一次是我做成的」：
//   DELETE FROM cases WHERE id=? AND deleted_at IS NOT NULL AND deleted_at <= ?
// 先查再删的两步形态是：两次 tick（或两个进程）先后查到同一行都「该删」，
// 于是收尾动作（回收密文文件、记账）跑两遍，而第二遍面对的是一个已经不存在的案子。
import type { Database } from 'better-sqlite3';

// ───────────────────────────── 案件软删 / 硬删 ─────────────────────────────

/**
 * 标记一个案件已删除。返回 true 表示**这一次**真的标上了；false = 它本来就已经是删除态
 * （调用方据此回 already_deleted，而不是把首次删除时刻改写成现在）。
 */
export function markCaseDeleted(db: Database, caseId: number, now: string): boolean {
  return (
    db.prepare('UPDATE cases SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, caseId)
      .changes === 1
  );
}

/**
 * 收回这个案子名下**还活着**的全部分享链接，返回收回了几条。
 *
 * 【为什么删案的同一步就要收链接，而不是等 30 天后随案删掉】分享链接是免登录的：
 * 谁拿到谁能打开。用户按下删除的那一刻，他想的是「这些东西别人看不到了」，
 * 而链接还在的话，那 30 天里任何持有它的人照样打得开——**删除与失效之间的这段窗口，
 * 恰恰是用户以为自己已经关上门的那段时间**。
 */
export function revokeCaseShares(db: Database, caseId: number, now: string): number {
  return db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE case_id = ? AND revoked_at IS NULL')
    .run(now, caseId).changes;
}

export interface DueCaseRow {
  id: number;
  user_id: number;
  deleted_at: string;
}

/** 已过保留期、该被硬删的案件。cutoff 由调用方按注入的时钟算出（canonical 串可直接比较）。 */
export function listCasesDueForPurge(db: Database, cutoff: string, limit: number): DueCaseRow[] {
  return db
    .prepare(
      `SELECT id, user_id, deleted_at FROM cases
        WHERE deleted_at IS NOT NULL AND deleted_at <= ?
        ORDER BY id LIMIT ?`,
    )
    .all(cutoff, limit) as DueCaseRow[];
}

/**
 * 硬删一个案件。子表全部 ON DELETE CASCADE（migrate.ts 逐条可查），所以这一句同时带走
 * 证据条目、对话、情绪与危机记录、时间线、诉求、报告、分享链接、文书。
 *
 * **不带走的两样是刻意的**：attestations.evidence_id 是 ON DELETE SET NULL（已出具的存证
 * 证明脱离案件继续存在，/verify/{orderNo} 照常可查），referral_offers.case_id 同样 SET NULL
 * （「这个人说过不需要」要比案件活得久）。
 *
 * 返回 true = 这一次删掉了；false = 别人先删了，或它已经不再满足到期条件。
 */
export function purgeCase(db: Database, caseId: number, cutoff: string): boolean {
  return (
    db
      .prepare('DELETE FROM cases WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?')
      .run(caseId, cutoff).changes === 1
  );
}

// ───────────────────────────── 账号注销 / 清理 ─────────────────────────────

export interface CancelledUserRow {
  id: number;
  cancelled_at: string;
}

/** 记下「这个人确认注销了」。返回 false = 之前已经注销过（首次时刻不改写）。 */
export function markUserCancelled(db: Database, userId: number, now: string): boolean {
  return (
    db
      .prepare('UPDATE users SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL')
      .run(now, userId).changes === 1
  );
}

/**
 * 抹掉 users 行上全部可识别字段。**行本身留着**：十余张表按 user_id 引着它且不带级联，
 * 而协议五.8 又要求支付记录与已出具的存证证明按法定期限保留——删掉这一行等于把要留的
 * 东西一起带走（外键也会当场拒绝）。
 *
 * 幂等：抹第二遍与第一遍等值（全都置 NULL），所以不设条件、可反复调用。
 * auth_status 回到未认证：实名状态是可识别信息的一部分，留着它等于留了一句
 *「这个空壳曾经是个实名用户」。
 */
export function anonymizeUser(db: Database, userId: number): void {
  db.prepare(
    `UPDATE users
        SET phone_enc = NULL,
            phone_hash = NULL,
            email = NULL,
            email_verified_at = NULL,
            phone_verified_at = NULL,
            real_name_enc = NULL,
            id_card_enc = NULL,
            cert_type = NULL,
            google_sub = NULL,
            linked_nbdpsy_customer_code = NULL,
            auth_status = '未认证'
      WHERE id = ?`,
  ).run(userId);
}

/** 已过保留期、该做最终清理的注销账号。 */
export function listUsersDueForPurge(db: Database, cutoff: string, limit: number): CancelledUserRow[] {
  return db
    .prepare(
      `SELECT id, cancelled_at FROM users
        WHERE cancelled_at IS NOT NULL AND cancelled_at <= ? AND purged_at IS NULL
        ORDER BY id LIMIT ?`,
    )
    .all(cutoff, limit) as CancelledUserRow[];
}

/**
 * 抢占「这一次由我来清理这个账号」。返回 true 才继续做后面的抹除动作。
 * purged_at 既是完成标记也是抢占位——同 extraction_jobs.refunded_at 的用法。
 */
export function claimUserPurge(db: Database, userId: number, cutoff: string, now: string): boolean {
  return (
    db
      .prepare(
        `UPDATE users SET purged_at = ?
          WHERE id = ? AND cancelled_at IS NOT NULL AND cancelled_at <= ? AND purged_at IS NULL`,
      )
      .run(now, userId, cutoff).changes === 1
  );
}

/**
 * 停用这个人名下**全部** api key（置 enabled=0，留行保审计线索，同设置页那个吊销按钮）。
 * OAuth 换来的 access token 也一并失效——它们挂靠的正是这些行（见 lib/auth/identity 的
 * resolveOauthAccessToken：key.enabled !== 1 即拒）。返回停用了几把。
 */
export function disableAllApiKeys(db: Database, userId: number): number {
  return db.prepare('UPDATE api_keys SET enabled = 0 WHERE user_id = ? AND enabled = 1').run(userId)
    .changes;
}

/**
 * 吊销这个人名下全部还活着的 OAuth 令牌。
 *
 * 【为什么停用 key 之后还要单独吊销令牌】停用 key 已经让令牌验不过了，但 oauth_tokens 那些行
 * 仍然是「未吊销」态。留着它们，任何按 revoked_at 判断「这次授权还在不在」的地方
 * （运维排障、将来的授权管理页）都会读出一个与事实相反的答案。
 */
export function revokeAllOauthTokens(db: Database, userId: number, now: string): number {
  return db
    .prepare(
      `UPDATE oauth_tokens SET revoked_at = ?
        WHERE revoked_at IS NULL
          AND key_id IN (SELECT id FROM api_keys WHERE user_id = ?)`,
    )
    .run(now, userId).changes;
}

export interface UserLifecycleRow {
  id: number;
  cancelled_at: string | null;
  purged_at: string | null;
}

export function findUserLifecycle(db: Database, userId: number): UserLifecycleRow | undefined {
  return db.prepare('SELECT id, cancelled_at, purged_at FROM users WHERE id = ?').get(userId) as
    | UserLifecycleRow
    | undefined;
}

// ───────────────────────────── 同意台账 ─────────────────────────────

export interface ConsentRow {
  id: number;
  user_id: number;
  kind: string;
  granted_at: string | null;
  revoked_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const CONSENT_COLUMNS =
  'id, user_id, kind, granted_at, revoked_at, note, created_at, updated_at';

export function findConsent(db: Database, userId: number, kind: string): ConsentRow | undefined {
  return db
    .prepare(`SELECT ${CONSENT_COLUMNS} FROM consents WHERE user_id = ? AND kind = ?`)
    .get(userId, kind) as ConsentRow | undefined;
}

export function listConsents(db: Database, userId: number): ConsentRow[] {
  return db
    .prepare(`SELECT ${CONSENT_COLUMNS} FROM consents WHERE user_id = ? ORDER BY kind`)
    .all(userId) as ConsentRow[];
}

/**
 * 撤回一项同意。**没有行也能撤**：插一条 granted_at 为空、revoked_at=now 的行，
 * 语义是「这个人明确说过不要」——本表落地之前跑起来的功能没留下过任何同意行，
 * 而那些人恰恰最需要能把它关掉。
 *
 * 返回 false = 之前已经撤过（首次撤回时刻不改写，同 revokeShare 的口径）。
 * 两条路径合成一句 INSERT ... ON CONFLICT：先查再写的两步之间，并发的第二次撤回会
 * 撞上唯一索引直接抛错，而它本该是一次成功的幂等重放。
 */
export function revokeConsent(
  db: Database,
  input: { userId: number; kind: string; now: string; note?: string | null },
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO consents (user_id, kind, granted_at, revoked_at, note, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE
           SET revoked_at = excluded.revoked_at,
               note = COALESCE(excluded.note, consents.note),
               updated_at = excluded.updated_at
         WHERE consents.revoked_at IS NULL`,
      )
      .run(input.userId, input.kind, input.now, input.note ?? null, input.now).changes === 1
  );
}

// ───────────────────────────── 转介删除请求 ─────────────────────────────

export interface ReferralDeleteRequestRow {
  id: number;
  referral_id: number | null;
  user_id: number;
  external_ref: string | null;
  status: string;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  requested_at: string;
  updated_at: string;
}

const RDR_COLUMNS =
  'id, referral_id, user_id, external_ref, status, reason, attempts, last_error, requested_at, updated_at';

export function findReferralDeleteRequest(
  db: Database,
  referralId: number,
): ReferralDeleteRequestRow | undefined {
  return db
    .prepare(`SELECT ${RDR_COLUMNS} FROM referral_delete_requests WHERE referral_id = ?`)
    .get(referralId) as ReferralDeleteRequestRow | undefined;
}

export function listReferralDeleteRequests(
  db: Database,
  userId: number,
): ReferralDeleteRequestRow[] {
  return db
    .prepare(`SELECT ${RDR_COLUMNS} FROM referral_delete_requests WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as ReferralDeleteRequestRow[];
}

export function insertReferralDeleteRequest(
  db: Database,
  input: {
    referralId: number;
    userId: number;
    externalRef: string | null;
    reason: string | null;
    status: string;
    now: string;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO referral_delete_requests
         (referral_id, user_id, external_ref, reason, status, requested_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.referralId,
      input.userId,
      input.externalRef,
      input.reason,
      input.status,
      input.now,
      input.now,
    );
  return Number(info.lastInsertRowid);
}

/** 回填发送结果。attempts 只在真发过（不论成败）时 +1，与 referrals 那侧同义。 */
export function updateReferralDeleteRequest(
  db: Database,
  input: {
    id: number;
    status: string;
    lastError: string | null;
    bumpAttempts: boolean;
    now: string;
  },
): void {
  db.prepare(
    `UPDATE referral_delete_requests
        SET status = ?, last_error = ?, attempts = attempts + ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.status, input.lastError, input.bumpAttempts ? 1 : 0, input.now, input.id);
}

// ───────────────────────────── 注销验证码 ─────────────────────────────
//
// 【为什么不复用登录那一桶码】lib/db/otp.ts 的头注释把这条写成红线：取码必须按 purpose
// 隔离，否则「同一串数字在两个语义完全不同的闸门上都好使」——一条为登录发出的码
// 就能拿去注销账号。所以注销走自己的 purpose='cancel' 桶，与登录那一桶互不可见。
//
// 表沿用 sms_codes / email_codes（结构、限流字段、过期与锁定语义都对得上），
// 只是 purpose 不同；另建一张表等于把同一件事的实现写两份。

/** 注销码的 purpose 值。与 lib/db/otp 的 'login' / 'verify' / 'register' 并列，互不可见。 */
export const CANCEL_CODE_PURPOSE = 'cancel';

/** 验证码走哪条通道。 */
export type CancelCodeChannel = 'sms' | 'email';

/** 一行验证码的读取形态（与 lib/db/otp.OtpRow 同形，两张表结构一致）。 */
export interface CancelCodeRow {
  id: number;
  code: string;
  attempts: number;
  expires_at: string;
  used: number;
}

/** 某目标在 sinceIso 之后发过几条注销码（60 秒冷却读它）。两边都套 datetime()，理由同 lib/db/otp。 */
export function countCancelCodesSince(
  db: Database,
  channel: CancelCodeChannel,
  target: string,
  sinceIso: string,
): number {
  const sql =
    channel === 'sms'
      ? 'SELECT COUNT(*) AS n FROM sms_codes WHERE phone_hash = ? AND purpose = ? AND datetime(created_at) > datetime(?)'
      : 'SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND purpose = ? AND datetime(created_at) > datetime(?)';
  return (db.prepare(sql).get(target, CANCEL_CODE_PURPOSE, sinceIso) as { n: number }).n;
}

/** 落一条注销码。返回行 id：通道确认发不出去时调用方要拿它把这一行撤掉（同 lib/db/otp 的 F-204 口径）。 */
export function insertCancelCode(
  db: Database,
  params: {
    channel: CancelCodeChannel;
    target: string;
    code: string;
    expiresAt: string;
    createdAt: string;
  },
): number {
  const sql =
    params.channel === 'sms'
      ? 'INSERT INTO sms_codes (phone_hash, code, purpose, expires_at, used, attempts, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
      : 'INSERT INTO email_codes (email, code, purpose, expires_at, used, attempts, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)';
  return Number(
    db
      .prepare(sql)
      .run(params.target, params.code, CANCEL_CODE_PURPOSE, params.expiresAt, params.createdAt)
      .lastInsertRowid,
  );
}

/** 取该目标最新一条注销码；旧码不再可用（发新码即作废旧码，同登录那一桶）。 */
export function latestCancelCode(
  db: Database,
  channel: CancelCodeChannel,
  target: string,
): CancelCodeRow | undefined {
  const sql =
    channel === 'sms'
      ? 'SELECT id, code, attempts, expires_at, used FROM sms_codes WHERE phone_hash = ? AND purpose = ? ORDER BY id DESC LIMIT 1'
      : 'SELECT id, code, attempts, expires_at, used FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1';
  return db.prepare(sql).get(target, CANCEL_CODE_PURPOSE) as CancelCodeRow | undefined;
}

export function bumpCancelCodeAttempts(db: Database, channel: CancelCodeChannel, id: number): void {
  const table = channel === 'sms' ? 'sms_codes' : 'email_codes';
  db.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE id = ?`).run(id);
}

export function markCancelCodeUsed(db: Database, channel: CancelCodeChannel, id: number): void {
  const table = channel === 'sms' ? 'sms_codes' : 'email_codes';
  db.prepare(`UPDATE ${table} SET used = 1 WHERE id = ?`).run(id);
}

export function deleteCancelCode(db: Database, channel: CancelCodeChannel, id: number): void {
  const table = channel === 'sms' ? 'sms_codes' : 'email_codes';
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}
