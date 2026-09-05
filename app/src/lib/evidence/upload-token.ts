// app/src/lib/evidence/upload-token.ts
// 一次性上传地址的签发与消费（设计稿 §2 B：evidence_upload_url → PUT → evidence_register）。
//
// 【这条链路是为谁开的】MCP 里传不了大文件——工具入参是 JSON，一段录音塞不进去也不该塞。
// 所以 agent 先要一条一次性 PUT 地址，把字节交给 HTTP，再回 MCP 用同一个 token 登记条目。
//
// 【token 的两条硬约束，缺一条这条链路就是个开放写入口】
//   一次性：用过即作废。签发出去的是一条**不带鉴权头也能写字节**的地址，可重放的话，
//           凡是这条 URL 出现过的地方（日志、剪贴板、聊天记录）都成了往用户案卷里塞文件的入口。
//   短命：10 分钟。上传是当下的动作，不是待办；有效期长到"以后再传"就等于长期凭据。
// 两条都由库里那一行管（consumed_at / expires_at），不由调用方自觉。
import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { nowSql, toSql } from '@/lib/db/time';

import { maxUploadBytesFor } from './upload-guard';

/** token 有效期。设计稿 §2 B 写的就是 10 分钟。 */
export const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface UploadTokenRow {
  id: number;
  token_hash: string;
  case_id: number;
  user_id: number;
  filename: string;
  mime: string | null;
  size: number;
  expires_at: string;
  consumed_at: string | null;
  file_id: number | null;
  evidence_id: number | null;
  created_at: string;
}

const COLUMNS =
  'id, token_hash, case_id, user_id, filename, mime, size, expires_at, consumed_at, file_id, evidence_id, created_at';

/**
 * token 明文 → 库里存的哈希。
 *
 * 明文只在签发那一刻的返回值里存在过一次，库里只留哈希——与 api_keys 同口径：
 * 库被读走时，能直接拿去写字节的凭据一条都不该在里面。
 * 不加盐不迭代：这是 128 bit 全随机的短命串，不是人选的口令，慢哈希在这里只买到延迟。
 */
export function hashUploadToken(plain: string): string {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

/** 签发一个 token。返回明文（只此一次）与那一行。 */
export function issueUploadToken(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    filename: string;
    mime: string | null;
    size: number;
    now?: Date;
  },
): { token: string; row: UploadTokenRow; expiresAt: string } {
  const plain = crypto.randomBytes(16).toString('hex');
  const now = input.now ?? new Date();
  const expiresAt = toSql(new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS));
  const id = Number(
    db
      .prepare(
        `INSERT INTO evidence_upload_tokens (token_hash, case_id, user_id, filename, mime, size, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        hashUploadToken(plain),
        input.caseId,
        input.userId,
        input.filename,
        input.mime,
        input.size,
        expiresAt,
      ).lastInsertRowid,
  );
  return { token: plain, row: findByHash(db, hashUploadToken(plain)) as UploadTokenRow, expiresAt };
}

function findByHash(db: Database, tokenHash: string): UploadTokenRow | null {
  return (db
    .prepare(`SELECT ${COLUMNS} FROM evidence_upload_tokens WHERE token_hash = ?`)
    .get(tokenHash) ?? null) as UploadTokenRow | null;
}

/** 按明文取那一行（读，不消费）。不存在返回 null。 */
export function findUploadToken(db: Database, plain: string): UploadTokenRow | null {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return null;
  return findByHash(db, hashUploadToken(trimmed));
}

/** 这一行现在能不能用来收字节。分档回原因，调用方据此选错误码。 */
export type TokenState = 'ok' | 'not_found' | 'expired' | 'consumed';

export function inspectUploadToken(
  db: Database,
  plain: string,
  now: string = nowSql(),
): { state: TokenState; row: UploadTokenRow | null } {
  const row = findUploadToken(db, plain);
  if (!row) return { state: 'not_found', row: null };
  // 【先判用过、再判过期】一个用过的 token 放到十分钟后同时满足两个条件，
  // 那时更该说的是"这条地址已经用过了"——说"过期了"会把人引去重签一条，
  // 而真正发生的事是他重复上传了。
  if (row.consumed_at !== null) return { state: 'consumed', row };
  // canonical 串可直接字符串比较（ADR-002），不必解析成 Date
  if (row.expires_at <= now) return { state: 'expired', row };
  return { state: 'ok', row };
}

/**
 * 抢占这个 token（一次性的实现处）。抢到返回那一行，没抢到返回 null。
 *
 * 【为什么是一句带条件的 UPDATE，不是"先查再写"】读请求体是 await，两个并发 PUT
 * 完全可能都在 await 之前查到"没用过"，然后双双落盘、案卷里多一份。
 * 条件写把判定与写入压成一次原子操作，按 changes===1 认领。
 */
export function claimUploadToken(
  db: Database,
  plain: string,
  now: string = nowSql(),
): UploadTokenRow | null {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return null;
  const tokenHash = hashUploadToken(trimmed);
  const res = db
    .prepare(
      `UPDATE evidence_upload_tokens SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, tokenHash, now);
  if (res.changes !== 1) return null;
  return findByHash(db, tokenHash);
}

/** 字节落库后回填 file_id。 */
export function attachFile(db: Database, tokenId: number, fileId: number): void {
  db.prepare('UPDATE evidence_upload_tokens SET file_id = ? WHERE id = ?').run(fileId, tokenId);
}

/** 登记出条目后回填 evidence_id。条件写：已经登记过的 token 不会被第二次挂到别的条目上。 */
export function attachEvidence(db: Database, tokenId: number, evidenceId: number): boolean {
  return (
    db
      .prepare('UPDATE evidence_upload_tokens SET evidence_id = ? WHERE id = ? AND evidence_id IS NULL')
      .run(evidenceId, tokenId).changes === 1
  );
}

/** 这个 token 声明的这份文件，允许多大。签发一刻就据此拒掉超档的，省得白传一遍。 */
export function declaredLimitFor(row: Pick<UploadTokenRow, 'mime'>): number {
  return maxUploadBytesFor(row.mime);
}
