// app/src/lib/evidence/files.ts
// 证据文件库：按 SHA-256 去重、AES-256-GCM 整文件加密落盘（spec §3.5、§10）。
//
// 落盘布局：$FILES_DIR/<sha 前 2 位>/<sha>.enc
// 分两级目录是因为单目录放几十万个文件后 readdir/stat 会明显变慢。
// files.enc_path 存**相对 FILES_DIR 的路径**，这样换挂载点、换机器都不用改库。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'better-sqlite3';

import { decryptBuffer, encryptBuffer } from '@/lib/crypto';
import * as store from '@/lib/db/evidence';

export interface StoredFile {
  fileId: number;
  sha256: string;
  size: number;
  /** true = 库里本来就有同哈希文件，本次没有重复落盘 */
  deduped: boolean;
}

function filesDir(): string {
  return process.env.FILES_DIR ?? path.join(process.cwd(), 'data', 'files');
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 相对路径：<前2位>/<sha>.enc */
function relPathFor(sha256: string): string {
  return path.join(sha256.slice(0, 2), `${sha256}.enc`);
}

/**
 * 存一份字节流。同哈希文件已在库中则直接复用既有行，不重复加密也不重复落盘。
 *
 * 注意去重是**全局**的：两个用户传了同一份文件只存一份密文，
 * 两条 evidence 记录指向同一个 file_id。这是 spec 要的行为（按哈希去重），
 * 谁能看到哪条证据由 evidence.user_id 管，与文件库无关。
 */
export function storeBytes(
  db: Database,
  bytes: Buffer,
  mime: string | null,
): StoredFile {
  const sha256 = sha256Hex(bytes);

  const existing = store.findFileBySha256(db, sha256);
  if (existing) {
    return { fileId: existing.id, sha256, size: existing.size, deduped: true };
  }

  const rel = relPathFor(sha256);
  const abs = path.join(filesDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 先落盘再落库：反过来的话进程在两步之间挂掉会留下「库里有行、盘上无文件」的
  // 幽灵记录，取证时才发现。反向的残留（盘上有文件、库里无行）只是占点空间，
  // 下次同哈希上传会原样复用。
  fs.writeFileSync(abs, encryptBuffer(bytes));

  const { row, inserted } = store.insertFileIfAbsent(db, {
    sha256,
    size: bytes.length,
    mime,
    encPath: rel,
  });
  return { fileId: row.id, sha256, size: row.size, deduped: !inserted };
}

/** 取回明文字节。文件缺失或密文被改动一律抛错，绝不返回残缺内容。 */
export function readBytes(db: Database, fileId: number): Buffer {
  const row = store.findFileById(db, fileId);
  if (!row) throw new Error(`文件不存在: file_id=${fileId}`);
  const abs = path.join(filesDir(), row.enc_path);
  if (!fs.existsSync(abs)) {
    throw new Error(`文件记录存在但密文缺失: file_id=${fileId} enc_path=${row.enc_path}`);
  }
  const plain = decryptBuffer(fs.readFileSync(abs));
  // 解密后复算哈希：能挡住「密文被换成另一份合法密文」——GCM 只保证单个文件
  // 自身未被篡改，保证不了盘上这个位置放的还是当初那份。
  const actual = sha256Hex(plain);
  if (actual !== row.sha256) {
    throw new Error(`文件哈希不符: file_id=${fileId} 期望 ${row.sha256} 实得 ${actual}`);
  }
  return plain;
}
