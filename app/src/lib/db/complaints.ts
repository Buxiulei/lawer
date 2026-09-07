// app/src/lib/db/complaints.ts
// complaints 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构与各列语义见 migrate.ts。
//
// 这一层只忠实读写，不判类型合法、不生成编号、不加解密——那些在 lib/complaints。
//
// 【为什么插入要把「编号撞车」原样抛出去】受理编号是给用户的凭据，撞车必须让上层看见
// 并换一个重试。在这一层吞掉（比如 INSERT OR IGNORE）的形态是：接口回 200、
// 页面上给用户印了一串编号，而库里那一行是**别人的**投诉。
import type { Database } from 'better-sqlite3';

export interface ComplaintRow {
  id: number;
  receipt_no: string;
  user_id: number | null;
  kind: string;
  body: string;
  contact_enc: string;
  created_at: string;
}

const COLUMNS = 'id, receipt_no, user_id, kind, body, contact_enc, created_at';

/** SQLite 的唯一约束冲突。撞的是 receipt_no 时上层要换一串再来。 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: complaints\.receipt_no/i.test(err.message)
  );
}

export function insertComplaint(
  db: Database,
  params: {
    receiptNo: string;
    userId: number | null;
    kind: string;
    body: string;
    /** 已加密的联系方式（lib/complaints 负责加密，本层不认识明文） */
    contactEnc: string;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO complaints (receipt_no, user_id, kind, body, contact_enc)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(params.receiptNo, params.userId, params.kind, params.body, params.contactEnc);
  return Number(info.lastInsertRowid);
}

export function findComplaintById(db: Database, id: number): ComplaintRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM complaints WHERE id = ?`).get(id) as
    | ComplaintRow
    | undefined;
}

/** 某个用户自己提交过的，最新的在前。 */
export function listComplaintsByUser(db: Database, userId: number): ComplaintRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM complaints WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as ComplaintRow[];
}

/** 后台列表：全部，最新的在前。limit 挡的是有人刷了几万条把后台页拖垮。 */
export function listAllComplaints(db: Database, limit = 200): ComplaintRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM complaints ORDER BY id DESC LIMIT ?`)
    .all(limit) as ComplaintRow[];
}
