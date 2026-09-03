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

/** 按 id 取一行。护照通道的人工审核要先读出材料哈希与信封，再决定落不落定。 */
export function findById(db: Database, id: number): RealnameVerificationRow | undefined {
  return db.prepare('SELECT * FROM realname_verifications WHERE id = ?').get(id) as
    | RealnameVerificationRow
    | undefined;
}

/**
 * 三方回调落定结论时推进本行状态。合法迁移由 lib/realname 判，本层不拦。
 * rawMetaEnc 传了就一并覆盖（落定时通常要把三方原始报文并进信封），不传则不动该列。
 */
export function setStatus(
  db: Database,
  verificationId: number,
  status: string,
  rawMetaEnc?: string,
): void {
  if (rawMetaEnc === undefined) {
    db.prepare('UPDATE realname_verifications SET status = ? WHERE id = ?').run(
      status,
      verificationId,
    );
    return;
  }
  db.prepare('UPDATE realname_verifications SET status = ?, raw_meta_enc = ? WHERE id = ?').run(
    status,
    rawMetaEnc,
    verificationId,
  );
}

/**
 * 该用户**最新一条**核验流水的 id（没有流水则 null）。
 *
 * 【为什么审核前要拿它比一次】队列（listPendingByProvider）与用户端状态（latestByUser）
 * 都只认 MAX(id) 那一行。管理员的页面是一份快照：他打开队列之后、点「通过」之前，
 * 那个人完全可能又交了一份新材料。此时旧行仍是「待审」，approve 会**成功落定**，
 * 而 /realname/status 读的是那条更新的行 —— 用户界面继续显示「等待人工核验」，
 * 管理员界面显示「已通过」。不报错、不崩，两边各看各的。
 * 所以落定前比一次 MAX(id)：不是最新的一律 409，让操作者先刷新再决定。
 */
export function latestVerificationIdForUser(db: Database, userId: number): number | null {
  const row = db
    .prepare('SELECT MAX(id) AS id FROM realname_verifications WHERE user_id = ?')
    .get(userId) as { id: number | null } | undefined;
  return row?.id ?? null;
}

/**
 * 某个 provider 下待人工审核的流水，**每个用户至多一行**：只列出「这一行正好是该用户
 * 最新一次核验」的那些。
 *
 * 【为什么必须收敛到每人一行】发起实名不挡「待审」态（initPassportRealname 只挡已实名），
 * 所以同一个人可以连交两次护照材料，库里就有两条 待审。而判「当前实名状态」的
 * latestByUser 只认 id 最大的那条 —— 审核台若把旧行也列出来，管理员点了旧行的「通过」，
 * users 表会转「已实名」，可 /realname/status 读到的仍是那条更新的 待审 行，
 * 页面继续显示「等待人工核验」。这种不一致不报错、不崩，只是让用户和管理员各看各的。
 * 于是这里用「id = 该用户的 MAX(id)」把队列钉在与 latestByUser 同一行上。
 */
export function listPendingByProvider(
  db: Database,
  provider: string,
  status: string,
): RealnameVerificationRow[] {
  return db
    .prepare(
      `SELECT v.* FROM realname_verifications v
        WHERE v.provider = ? AND v.status = ?
          AND v.id = (SELECT MAX(w.id) FROM realname_verifications w WHERE w.user_id = v.user_id)
        ORDER BY v.id DESC`,
    )
    .all(provider, status) as RealnameVerificationRow[];
}
