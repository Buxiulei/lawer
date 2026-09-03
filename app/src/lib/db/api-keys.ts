// app/src/lib/db/api-keys.ts
// api_keys 表封装（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 【两列各司其职，不许互相替代】
//   key_hash   —— 鉴权用。SHA256，确定性，UNIQUE 索引上等值查找（findEnabledApiKeyByHash）。
//   secret_enc —— 「让用户回来还能看见自己的密钥」用。AES-256-GCM 自包含密文（lib/crypto），
//                 每次加密 iv 随机，**不可用于查找**，也永远不参与鉴权判断。
// 拿 secret_enc 去比对身份，或拿 key_hash 去当明文回显，都是把这两件事混成一件。
import type { Database } from 'better-sqlite3';

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  key_hash: string;
  /** JSON 数组字符串，创建时总是写入显式数组，不留 NULL */
  scopes: string | null;
  last_used_at: string | null;
  enabled: number;
  created_at: string;
  /**
   * MCP 客户端在 `initialize` 里自报的名字（clientInfo.name）。
   * 走 REST 的客户端不报名字 → 恒为 null。**不编默认值**：读侧退到 name，
   * 并在页面上说明那是用户自己起的名，否则等于假装我们认出了他的助手。
   */
  client_name: string | null;
  /**
   * key 明文的 AES-256-GCM 密文（lib/crypto encryptField）。签发与轮换时写。
   * NULL = 本列上线之前签发的存量密钥，明文当年就没留下，**今天也变不出来**——
   * 读侧据此显示「旧密钥不可查看，请轮换」，不编默认值。
   */
  secret_enc: string | null;
  /** 最近一次轮换时间。NULL = 从没轮换过（不是「很久以前轮换过」）。 */
  rotated_at: string | null;
}

/** 列表行：不回显 key_hash，也不回显密文本身——只回「这把能不能查看明文」。 */
export interface ApiKeyListRow extends Omit<ApiKeyRow, 'key_hash' | 'secret_enc'> {
  /** better-sqlite3 给的是 0/1，路由层转布尔（同 enabled 的既有写法） */
  viewable: number;
}

/**
 * 列出某用户的 key。
 * 不含 key_hash（接口层没有任何理由回显它），也不含 secret_enc——密文只在
 * GET /keys/{id}/secret 那一条路径上解密，列表页只需要知道「这把能不能查看」。
 */
export function listApiKeys(db: Database, userId: number): ApiKeyListRow[] {
  return db
    .prepare(
      'SELECT id, user_id, name, scopes, last_used_at, enabled, created_at, client_name, rotated_at,' +
        ' (secret_enc IS NOT NULL) AS viewable' +
        ' FROM api_keys WHERE user_id = ? ORDER BY id DESC',
    )
    .all(userId) as ApiKeyListRow[];
}

/**
 * created_at 交给列 DEFAULT (datetime('now'))，不从 JS 落串（ADR-002）。
 *
 * secretEnc **必填**：从本列上线起签发的每一把 key 都要留密文，否则用户下次回来
 * 看到的是「旧密钥不可查看，请轮换」——刚生成就"旧"了。调用方传的必须是
 * `encryptField(明文)`，不是 hash、不是明文本身（判据 C19 盯着这一点）。
 */
export function insertApiKey(
  db: Database,
  params: { userId: number; name: string; keyHash: string; scopesJson: string; secretEnc: string },
): number {
  const info = db
    .prepare(
      'INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, secret_enc) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run(params.userId, params.name, params.keyHash, params.scopesJson, params.secretEnc);
  return Number(info.lastInsertRowid);
}

/** 按 hash 反查启用中的 key。key_hash 上有 UNIQUE 索引，等值查找走索引。 */
export function findEnabledApiKeyByHash(db: Database, keyHash: string): ApiKeyRow | undefined {
  return db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1')
    .get(keyHash) as ApiKeyRow | undefined;
}

export function findApiKeyById(db: Database, id: number): ApiKeyRow | undefined {
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
}

/**
 * 记下客户端自报的名字。**只在有名字时调**——传空会把已有的名字抹成空串。
 * 名字由调用方截断到 64 字符：它是对方随便填的字符串，不设上限就等于让别人决定我们存多长。
 */
export function recordClientName(db: Database, id: number, name: string): void {
  db.prepare('UPDATE api_keys SET client_name = ? WHERE id = ?').run(name, id);
}

/** 时间由 SQLite 自己取，不从 JS 落 ISO 串（ADR-002 canonical = datetime('now')） */
export function touchApiKeyLastUsed(db: Database, id: number): void {
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * 轮换：换一把新明文，id / name / scopes / client_name 原样保留。
 *
 * 【last_used_at 清零不是可选装饰】「接没接上」的判据就是这一列非空
 *（_ui/useConnectedAgent）。旧明文这一刻起立刻作废，若不清零，页面会在新明文
 * 还没被任何 agent 用过之前继续显示「已接入 · 最近一次 X」——那个时间戳指的是
 * 一把已经不能用的凭据，而用户据此以为不用重新配置。
 *
 * 【client_name 不动】那是上一次握手时对方自报的名字，说的是「这把 key 代表谁」；
 * 轮换换的是密钥，不是身份。抹掉它等于让页面从此只念用户自己起的备注名。
 */
export function rotateApiKeySecret(
  db: Database,
  id: number,
  params: { keyHash: string; secretEnc: string },
): void {
  db.prepare(
    "UPDATE api_keys SET key_hash = ?, secret_enc = ?, rotated_at = datetime('now'), last_used_at = NULL WHERE id = ?",
  ).run(params.keyHash, params.secretEnc, id);
}

/**
 * 吊销。不删行：key_hash 上有 UNIQUE 约束，留着行可以防止同一把 key 被重新注册，
 * 也保住"这把 key 什么时候创建、最后一次用在什么时候"的审计线索。
 */
export function disableApiKey(db: Database, id: number): void {
  db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(id);
}
