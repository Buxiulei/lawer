// app/src/lib/db/realname.ts
// realname_verifications 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 只追加 + 只读：一次核验一行，用户改名/换证 = 新一行，历史核验记录不改不删。
// users.auth_status 是本表结论的物化缓存，由 lib/realname 域层同步——本文件不碰 users。
//
// raw_meta_enc 是三方核验原始报文的**密文**（内含姓名身份证，争议时要能回溯）。
// 本层收到什么存什么，加密在 lib/crypto 做完再传进来——本文件不认识明文，也不该认识。
//
// setStatus 只做"把这一行的 status 改成给定值"，状态机的合法迁移（pending → …）
// 归 lib/realname，M2 扩状态语义时改那边，不改本层。
import type { Database } from 'better-sqlite3';

export interface RealnameVerificationRow {
  id: number;
  user_id: number;
  provider: string;
  cert_no: string | null;
  status: string;
  raw_meta_enc: string | null;
  created_at: string;
}

/** provider 为 cloudauth | eid | manual（枚举归 lib/realname，本层只当字符串存）。 */
export function insertVerification(
  db: Database,
  params: {
    userId: number;
    provider: string;
    certNo?: string | null;
    status?: string;
    /** 已加密的三方原始报文；明文不得传进来 */
    rawMetaEnc?: string | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO realname_verifications (user_id, provider, cert_no, status, raw_meta_enc)
       VALUES (?, ?, ?, COALESCE(?, 'pending'), ?)`,
    )
    .run(
      params.userId,
      params.provider,
      params.certNo ?? null,
      params.status ?? null,
      params.rawMetaEnc ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** 最近一次核验（走 idx_realname_verifications_user）。判"当前实名状态"用它。 */
export function latestByUser(db: Database, userId: number): RealnameVerificationRow | undefined {
  return db
    .prepare('SELECT * FROM realname_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId) as RealnameVerificationRow | undefined;
}

/** 三方回调落定结论时推进本行状态。合法迁移由 lib/realname 判，本层不拦。 */
export function setStatus(db: Database, verificationId: number, status: string): void {
  db.prepare('UPDATE realname_verifications SET status = ? WHERE id = ?').run(
    status,
    verificationId,
  );
}
