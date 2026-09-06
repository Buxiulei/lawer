// app/src/lib/db/referrals.ts
// referrals 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构与各列语义见 migrate.ts。
//
// 这一层不做归属校验、不判同意、不认识数据包里有什么，只忠实读写；
// 「这个案件是不是这个用户的」「consent 有没有给」由 lib/referral 把关。
//
// 【为什么状态迁移写成带 WHERE 的 UPDATE，而不是先读后写】发送是后台队列在跑，
// 同一行可能被上一轮的收尾和这一轮的领取同时碰到。先 SELECT 判状态再 UPDATE 的形态是：
// 两次都读到 pending，于是同一份数据包发两遍，对方 leads 里出现两条一模一样的线索。
// 把判据放进 WHERE、按 changes 判有没有抢到，这一步就没有中间状态。
import type { Database } from 'better-sqlite3';

/** out = 我们转给对方；in = 对方转过来（P4 反向，先留位）。 */
export type ReferralDirection = 'out' | 'in';

/** pending 还没发出去/等重试；sent 对方已收；accepted/declined 对方回执；failed 重试用尽。 */
export type ReferralStatus = 'pending' | 'sent' | 'accepted' | 'declined' | 'failed';

export interface ReferralRow {
  id: number;
  case_id: number;
  user_id: number;
  direction: string;
  status: string;
  payload_json: string;
  consent_at: string;
  external_ref: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  `id, case_id, user_id, direction, status, payload_json, consent_at,
   external_ref, attempts, last_error, created_at, updated_at`;

export function insertReferral(
  db: Database,
  params: {
    caseId: number;
    userId: number;
    /** 已经过中立化过滤的数据包全文 */
    payloadJson: string;
    /** 用户点「同意并转介」的时刻（ISO / canonical 串） */
    consentAt: string;
    direction?: ReferralDirection;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO referrals (case_id, user_id, direction, payload_json, consent_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.caseId,
      params.userId,
      params.direction ?? 'out',
      params.payloadJson,
      params.consentAt,
    );
  return Number(info.lastInsertRowid);
}

export function findReferralById(db: Database, id: number): ReferralRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM referrals WHERE id = ?`).get(id) as
    | ReferralRow
    | undefined;
}

/** 某案的转介台账，最新在前。 */
export function listReferralsByCase(db: Database, caseId: number): ReferralRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM referrals WHERE case_id = ? ORDER BY id DESC`)
    .all(caseId) as ReferralRow[];
}

/** 某人名下全部转介台账，最新在前。设置页那张卡按它判「要不要显示这张卡」。 */
export function listReferralsByUser(db: Database, userId: number): ReferralRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM referrals WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as ReferralRow[];
}

/** 还等着发出去的那些（按 id 升序＝先来先发）。 */
export function listPendingReferrals(db: Database, limit: number): ReferralRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM referrals WHERE status = 'pending' ORDER BY id LIMIT ?`)
    .all(limit) as ReferralRow[];
}

/**
 * 发送成功：落 external_ref 并转 sent。**只对还是 pending 的那行生效**，
 * 返回是否真的改到了——抢输的一方据此知道「这条已经被别人发过了，别再发一次」。
 */
export function markSent(db: Database, id: number, externalRef: string): boolean {
  const info = db
    .prepare(
      `UPDATE referrals
          SET status = 'sent', external_ref = ?, last_error = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
    )
    .run(externalRef, id);
  return info.changes === 1;
}

/**
 * 一次发送失败。
 *
 * `countsAsAttempt=false` 用于「对方压根没接通」（缺配置）：那不是这份数据包的问题，
 * 把它记成一次尝试，几轮之后这条转介就会被判 failed 而永远不再发——**而失败的原因
 * 是我们自己没接线**。所以那种情形只更新 last_error，次数不动，状态留在 pending。
 */
export function markAttemptFailed(
  db: Database,
  id: number,
  lastError: string,
  options: { countsAsAttempt: boolean; exhausted: boolean },
): void {
  db.prepare(
    `UPDATE referrals
        SET attempts = attempts + ?,
            last_error = ?,
            status = ?,
            updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
  ).run(
    options.countsAsAttempt ? 1 : 0,
    lastError,
    options.exhausted ? 'failed' : 'pending',
    id,
  );
}
