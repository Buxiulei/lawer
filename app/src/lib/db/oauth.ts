// app/src/lib/db/oauth.ts
// oauth_clients / oauth_codes / oauth_tokens 三张表的封装（spec §6：lib/db 是唯一 SQL 层）。
// 表结构与「为什么是三张表」见 migrate.ts。
//
// 【本文件只存哈希】code 与 token 的明文只在签发那一刻存在于内存里，随响应发走后即丢。
// 传进来的 *Hash 参数一律是 sha256 hex（lib/auth/oauth 的 hashSecret）。
import type { Database } from 'better-sqlite3';

export interface OauthClientRow {
  id: number;
  client_id: string;
  client_name: string;
  /** JSON 数组字符串 */
  redirect_uris: string;
  created_at: string;
}

export interface OauthCodeRow {
  id: number;
  code_hash: string;
  client_id: string;
  user_id: number;
  key_id: number;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface OauthTokenRow {
  id: number;
  token_hash: string;
  kind: 'access' | 'refresh';
  code_id: number;
  key_id: number;
  user_id: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export function insertClient(
  db: Database,
  params: { clientId: string; clientName: string; redirectUrisJson: string },
): void {
  db.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)',
  ).run(params.clientId, params.clientName, params.redirectUrisJson);
}

export function findClient(db: Database, clientId: string): OauthClientRow | undefined {
  return db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
    | OauthClientRow
    | undefined;
}

export function insertCode(
  db: Database,
  params: {
    codeHash: string;
    clientId: string;
    userId: number;
    keyId: number;
    redirectUri: string;
    codeChallenge: string;
    scopesJson: string;
    expiresAt: string;
  },
): number {
  const info = db
    .prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, user_id, key_id, redirect_uri, code_challenge, scopes, expires_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      params.codeHash,
      params.clientId,
      params.userId,
      params.keyId,
      params.redirectUri,
      params.codeChallenge,
      params.scopesJson,
      params.expiresAt,
    );
  return Number(info.lastInsertRowid);
}

/** 按哈希取 code。**取到不等于能用**：过期、已消费、client/redirect 对不上都由调用方判。 */
export function findCodeByHash(db: Database, codeHash: string): OauthCodeRow | undefined {
  return db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as
    | OauthCodeRow
    | undefined;
}

/**
 * 一次性消费：抢到返回 true，没抢到（已经被消费过）返回 false。
 * 条件写在 WHERE 里而不是先查后写——见 migrate.ts 里 consumed_at 那段。
 */
export function consumeCode(db: Database, codeHash: string, nowSql: string): boolean {
  return (
    db
      .prepare('UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL')
      .run(nowSql, codeHash).changes === 1
  );
}

export function insertToken(
  db: Database,
  params: {
    tokenHash: string;
    kind: 'access' | 'refresh';
    codeId: number;
    keyId: number;
    userId: number;
    expiresAt: string;
  },
): number {
  const info = db
    .prepare(
      'INSERT INTO oauth_tokens (token_hash, kind, code_id, key_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      params.tokenHash,
      params.kind,
      params.codeId,
      params.keyId,
      params.userId,
      params.expiresAt,
    );
  return Number(info.lastInsertRowid);
}

/** 按哈希取令牌（任意 kind、含已吊销与已过期）。"能不能用"由调用方按行上的列判。 */
export function findTokenByHash(db: Database, tokenHash: string): OauthTokenRow | undefined {
  return db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash) as
    | OauthTokenRow
    | undefined;
}

/**
 * 吊销整条链（同一条授权码派生出的全部令牌）。
 * 「复用旧 refresh」与「code 被用第二次」都走这一句——两种复用说明凭据已经泄漏，
 * 只作废被出示的那一条等于让攻击者留着另一半继续用。
 * @returns 本次实际改到的行数
 */
export function revokeChain(db: Database, codeId: number, nowSql: string): number {
  return db
    .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE code_id = ? AND revoked_at IS NULL')
    .run(nowSql, codeId).changes;
}

/** 吊销链上某一种令牌（旋转时用：先作废旧的 access 与 refresh，再发新的一对）。 */
export function revokeChainKind(
  db: Database,
  codeId: number,
  kind: 'access' | 'refresh',
  nowSql: string,
): number {
  return db
    .prepare(
      'UPDATE oauth_tokens SET revoked_at = ? WHERE code_id = ? AND kind = ? AND revoked_at IS NULL',
    )
    .run(nowSql, codeId, kind).changes;
}
