// app/src/lib/files/download-token.ts
// 一次性下载地址的签发与消费。**是 lib/evidence/upload-token.ts 的反向**，两条硬约束逐字相同：
//
//   一次性：取过即作废。签发出去的是一条**不带鉴权头也能取回文件**的地址（否则用户没法把它
//           丢进浏览器打开），可重放的话，凡是这条 URL 出现过的地方（日志、剪贴板、聊天记录）
//           都成了一个长期有效的取件口。
//   短命：10 分钟。下载是当下的动作，不是待办；有效期长到"以后再下"就等于长期凭据。
//
// 两条都由库里那一行管（consumed_at / expires_at），不由调用方自觉。
// 明文只在签发那一刻的返回值里存在过一次，库里只留哈希——与 api_keys / 上传令牌同口径。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { nowSql, toSql } from '@/lib/db/time';

/** 下载地址有效期。与上传令牌取同一个数：同一类东西（短命一次性凭据）不该有两个寿命。 */
export const DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface DownloadTokenRow {
  id: number;
  token_hash: string;
  file_id: number;
  user_id: number;
  filename: string;
  mime: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

const COLUMNS =
  'id, token_hash, file_id, user_id, filename, mime, expires_at, consumed_at, created_at';

/** 明文 → 库里存的哈希。不加盐不迭代：128 bit 全随机的短命串，慢哈希在这里只买到延迟。 */
export function hashDownloadToken(plain: string): string {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

function findByHash(db: Database, tokenHash: string): DownloadTokenRow | null {
  return (db
    .prepare(`SELECT ${COLUMNS} FROM file_download_tokens WHERE token_hash = ?`)
    .get(tokenHash) ?? null) as DownloadTokenRow | null;
}

/** 签发一条下载地址。返回明文（只此一次）与到期点。 */
export function issueDownloadToken(
  db: Database,
  input: { fileId: number; userId: number; filename: string; mime: string | null; now?: Date },
): { token: string; expiresAt: string } {
  const plain = crypto.randomBytes(16).toString('hex');
  const now = input.now ?? new Date();
  const expiresAt = toSql(new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS));
  db.prepare(
    `INSERT INTO file_download_tokens (token_hash, file_id, user_id, filename, mime, expires_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(hashDownloadToken(plain), input.fileId, input.userId, input.filename, input.mime, expiresAt);
  return { token: plain, expiresAt };
}

export type DownloadTokenState = 'ok' | 'not_found' | 'expired' | 'consumed';

/**
 * 这条地址现在能不能取件。分档回原因，调用方据此选错误码。
 * 【先判用过、再判过期】同 inspectUploadToken：一个用过的 token 放到十分钟后两个条件都满足，
 * 那时更该说的是"这条地址已经用过了"——说"过期了"会把人引去重签一条，而真正发生的事是重复下载。
 */
export function inspectDownloadToken(
  db: Database,
  plain: string,
  now: string = nowSql(),
): { state: DownloadTokenState; row: DownloadTokenRow | null } {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return { state: 'not_found', row: null };
  const row = findByHash(db, hashDownloadToken(trimmed));
  if (!row) return { state: 'not_found', row: null };
  if (row.consumed_at !== null) return { state: 'consumed', row };
  // canonical 串可直接字符串比较（ADR-002）
  if (row.expires_at <= now) return { state: 'expired', row };
  return { state: 'ok', row };
}

/**
 * 抢占这条地址（一次性的实现处）。抢到返回那一行，没抢到返回 null。
 * 与 claimUploadToken 同形：条件写把判定与写入压成一次原子操作，
 * 「先查再写」在两个并发 GET 之间会双双查到"没用过"，于是同一条地址发出去两份文件。
 */
export function claimDownloadToken(
  db: Database,
  plain: string,
  now: string = nowSql(),
): DownloadTokenRow | null {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return null;
  const tokenHash = hashDownloadToken(trimmed);
  const res = db
    .prepare(
      `UPDATE file_download_tokens SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, tokenHash, now);
  if (res.changes !== 1) return null;
  return findByHash(db, tokenHash);
}
