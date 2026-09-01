// app/src/lib/admin/audit.ts
// admin_audit 的**唯一写入口**。后台每一次变更都从这里落一行，别处不许自己拼 INSERT。
//
// 唯一写入口的理由与账本同一条（lib/billing/index.ts 抬头）：写点散开，
// 「有没有落审计」就变成了每个调用点各自的记性，而漏落不报错、不崩、只是安安静静地没记。
// 结构守卫 __tests__/audit-single-writer.test.ts 机检这条：admin 面除本文件外
// 出现 `INSERT INTO admin_audit` 即红。
import type Database from 'better-sqlite3';

/** action 值域（锁在这里，防拼写漂移；库侧不加 CHECK，沿 intake_stage 裁决）。 */
export const ADMIN_ACTION = {
  /** 调会员档：写 memberships 行（降档时先把当前行提前到期） */
  grantMembership: 'grant_membership',
  /** 发公道值：走 lib/billing 的 gongdaoGrant 入账 */
  grantGongdao: 'grant_gongdao',
} as const;
export type AdminAction = (typeof ADMIN_ACTION)[keyof typeof ADMIN_ACTION];

export interface AdminAuditRow {
  id: number;
  operator_uid: number;
  action: string;
  target_uid: number;
  detail_json: string | null;
  created_at: string;
}

/**
 * 落一行审计。**应与被审计的那次写在同一个事务里**（调用方 db.transaction 内调用）：
 * 分开写就会出现「钱发了但审计没落」或反过来，而这两种半截状态事后无法区分于「没发」。
 *
 * detail 必须写清后果（金额 / 档位 / 天数 / 幂等键 / 是否真生效），不许只写动作名——
 * 见 migrate.ts 里 admin_audit 的表注释。
 */
export function writeAudit(
  db: Database.Database,
  entry: {
    operatorUid: number;
    action: AdminAction;
    targetUid: number;
    detail: Record<string, unknown>;
  },
): void {
  db.prepare(
    'INSERT INTO admin_audit (operator_uid, action, target_uid, detail_json) VALUES (?,?,?,?)',
  ).run(entry.operatorUid, entry.action, entry.targetUid, JSON.stringify(entry.detail));
}

/** 最近的操作（倒序，最新在前）。给后台列表页「最近操作」用。 */
export function listRecentAudit(db: Database.Database, limit = 50): AdminAuditRow[] {
  const n = Math.max(1, Math.min(200, Math.trunc(limit)));
  return db
    .prepare(
      'SELECT id, operator_uid, action, target_uid, detail_json, created_at FROM admin_audit ORDER BY id DESC LIMIT ?',
    )
    .all(n) as AdminAuditRow[];
}
