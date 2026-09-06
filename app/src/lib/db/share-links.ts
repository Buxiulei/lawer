// app/src/lib/db/share-links.ts
// share_links 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 这一层不做归属校验，只忠实读写；"这个案件是不是这个用户的"由 lib/cases 把关。
//
// 分享链接是把整份档案（解除通知、工资流水、录音）交给免登录访问者的口子，
// 有效性判定必须在 SQL 里一次做完：token 命中 + 未过期 + 未撤销，三条缺一不可。
// 判"是否过期"一律用 SQL 侧 datetime('now') 与列比较——canonical 串之间可直接字符串比较
// （ADR-002），拿到应用层再比会引进时区与格式两个出错点。
// 撤销不删行（revoked_at 置时间戳），谁在什么时候撤了哪条链接要留得下审计。
import type { Database } from 'better-sqlite3';

export interface ShareLinkRow {
  id: number;
  case_id: number;
  token: string;
  scope: string;
  /** 分享标的类别；NULL = 整案档案只读（本表最早的形态，读侧要容得下） */
  target_kind: string | null;
  /** 标的行 id，随 target_kind 走 */
  target_id: number | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** 分享标的的值域。**只有这一份**：加第三种标的时这里加一个值，读侧的 switch 才会跟着报错。 */
export const SHARE_TARGET_KINDS = ['draft', 'evidence'] as const;
export type ShareTargetKind = (typeof SHARE_TARGET_KINDS)[number];

/**
 * token 由调用方生成（随机性归 lib/crypto，本层不造 token）。
 * expiresAt 传 ISO8601 或 canonical 串，由 datetime() 就地归一——不许存原样 ISO 串，
 * 混进去之后 'T' > ' ' 会让它恒排在全部 canonical 串之后，过期判定直接失效。
 * 表结构不设永久链：expires_at NOT NULL，本函数也不给它缺省。
 */
export function create(
  db: Database,
  params: {
    caseId: number;
    token: string;
    scope: string;
    expiresAt: string;
    targetKind?: ShareTargetKind;
    targetId?: number;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO share_links (case_id, token, scope, target_kind, target_id, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime(?))`,
    )
    .run(
      params.caseId,
      params.token,
      params.scope,
      params.targetKind ?? null,
      params.targetId ?? null,
      params.expiresAt,
    );
  return Number(info.lastInsertRowid);
}

/** 唯一的访问入口：拿不到行就是"这个链接不能用"，不区分不存在/过期/已撤销。 */
export function findActive(db: Database, token: string): ShareLinkRow | undefined {
  return db
    .prepare(
      `SELECT * FROM share_links
        WHERE token = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
    )
    .get(token) as ShareLinkRow | undefined;
}

/** 幂等：已撤销的链接再撤一次不改原时间戳（保留首次撤销时点）。 */
export function revoke(db: Database, id: number): void {
  db.prepare("UPDATE share_links SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(
    id,
  );
}

/** 管理视图：过期与已撤销的也要列出来（用户要看"我都分享给过谁"）。 */
export function listByCase(db: Database, caseId: number): ShareLinkRow[] {
  return db
    .prepare('SELECT * FROM share_links WHERE case_id = ? ORDER BY id DESC')
    .all(caseId) as ShareLinkRow[];
}

/**
 * 这条链接现在是什么状态。findActive 那种「拿不到行就是不能用」的口径对访问者够用
 * （不区分不存在 / 过期 / 已撤销是刻意的，防枚举），但对**打开链接的人**不够：
 * 一条刚过期的链接和一条从来不存在的链接，对他要说的话完全不同——前者该说"这条链接已到期，
 * 找分享给你的人再要一条"，后者只能说"没有这条链接"。所以分档回，由路由决定说到哪一层。
 *
 * 过期判定仍在 SQL 侧（datetime('now') 与列比较），与 findActive 同一把尺子。
 */
export type ShareLinkState = 'ok' | 'not_found' | 'expired' | 'revoked';

export function inspect(db: Database, token: string): { state: ShareLinkState; row: ShareLinkRow | null } {
  const trimmed = (token ?? '').trim();
  if (!trimmed) return { state: 'not_found', row: null };
  const row = db
    .prepare(
      `SELECT *, (expires_at <= datetime('now')) AS is_expired FROM share_links WHERE token = ?`,
    )
    .get(trimmed) as (ShareLinkRow & { is_expired: number }) | undefined;
  if (!row) return { state: 'not_found', row: null };
  // 【先判撤销、再判过期】一条被撤销的链接放到到期日之后同时满足两个条件，
  // 那时更该说的是"分享人已经把它收回了"——说"过期了"会把人引去要一条新的，
  // 而真正发生的事是对方不打算再给了。
  if (row.revoked_at !== null) return { state: 'revoked', row };
  if (row.is_expired) return { state: 'expired', row };
  return { state: 'ok', row };
}

/** 按 id 取一行（撤销前核对归属用）。 */
export function findById(db: Database, id: number): ShareLinkRow | undefined {
  return db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as ShareLinkRow | undefined;
}
