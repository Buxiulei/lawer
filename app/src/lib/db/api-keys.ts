// app/src/lib/db/api-keys.ts
// api_keys 表封装（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
// 铁律：库里只存 key 的 SHA256，明文只在创建那一刻返回给用户一次，之后无从找回。
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
}

/** 列出某用户的 key（不含 key_hash：接口层没有任何理由回显它） */
export function listApiKeys(db: Database, userId: number): Omit<ApiKeyRow, 'key_hash'>[] {
  return db
    .prepare(
      'SELECT id, user_id, name, scopes, last_used_at, enabled, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC',
    )
    .all(userId) as Omit<ApiKeyRow, 'key_hash'>[];
}

export function insertApiKey(
  db: Database,
  params: { userId: number; name: string; keyHash: string; scopesJson: string; createdAt: string },
): number {
  const info = db
    .prepare(
      'INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run(params.userId, params.name, params.keyHash, params.scopesJson, params.createdAt);
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

export function touchApiKeyLastUsed(db: Database, id: number, at: string): void {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id);
}

/**
 * 吊销。不删行：key_hash 上有 UNIQUE 约束，留着行可以防止同一把 key 被重新注册，
 * 也保住"这把 key 什么时候创建、最后一次用在什么时候"的审计线索。
 */
export function disableApiKey(db: Database, id: number): void {
  db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(id);
}
