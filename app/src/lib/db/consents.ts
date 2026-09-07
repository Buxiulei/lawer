// app/src/lib/db/consents.ts
// 同意台账的**唯一读写入口**（协议 v0.2 附一 #1–#6）。
//
// 【为什么只许有一个入口】同意有五个采集点（注册页、实名页、站内对话、设置页、MCP 闸门），
// 而「这次点头要落一行」这件事独立写五遍就会忘一遍。忘掉之后的形态最难发现：
// 页面上问过了、用户也点了头，库里没有那一行——于是闸门第二天又拦住他一次，
// 而两处看起来都在正常工作。所以谁都不许自己写一句 INSERT INTO consents。
// 这条由 lib/__tests__/consent-single-writer.test.ts 机检。
//
// 【为什么不并进 lib/db/otp.ts】那个文件是 OTP 与用户表的仓储，已经很长；
// 同意台账被 lib/auth、lib/capabilities、lib/agent、以及若干路由引用，
// 单独一个只依赖 Database 的叶子文件，谁引它都不会连带拖上别的东西。
//
// 【为什么不存 IP 明文】限流那张表已经论证过同一件事（见 migrate.ts ip_quota_events）：
// 台账要回答的是「这次点头是不是同一个人在同一处网络环境下做的」，摘要足够；
// 存明文等于把用户的位置信息与他的同意记录长期绑在一起，法律上不需要，隐私上不该留。
import type { Database } from 'better-sqlite3';

import { CONSENT_VERSIONS, type ConsentKind } from '@/lib/consent';
import { hashLookup, masterKeyConfigured } from '@/lib/crypto';

export interface ConsentRow {
  id: number;
  user_id: number;
  kind: string;
  version: string;
  at: string;
  ip_digest: string | null;
}

/**
 * IP → 摘要。密钥没配好时回 null（**不回落明文**，也不让整条同意写不进去）：
 * 摘要缺失只是日后少一条辅证，而写不进去等于用户点了头我们不认。
 *
 * 用 hashLookup（带密钥的 HMAC）而不是裸 sha256：IPv4 只有 43 亿个取值，
 * 裸摘要几分钟就能反查回明文，那等于换个名字存了明文。
 */
export function ipDigest(ip: string | null | undefined): string | null {
  const raw = (ip ?? '').trim();
  if (!raw || raw === 'unknown') return null;
  if (!masterKeyConfigured()) return null;
  return hashLookup(`consent-ip:${raw}`);
}

/**
 * 记一次同意。**同一个人、同一类、同一版本只落一行**（唯一索引兜底）：
 * 用户每次登录都会再勾一次协议，逐次落行的形态是台账里全是重复行，
 * 而「他第一次是什么时候同意的」反而要翻到最底下才找得到。
 *
 * @returns created=false 表示这一版此前已经同意过，本次没有新行。
 */
export function recordConsent(
  db: Database,
  input: { userId: number; kind: ConsentKind; version?: string; ipDigest?: string | null },
): { created: boolean } {
  const version = input.version ?? CONSENT_VERSIONS[input.kind];
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO consents (user_id, kind, version, ip_digest) VALUES (?,?,?,?)',
    )
    .run(input.userId, input.kind, version, input.ipDigest ?? null);
  return { created: res.changes > 0 };
}

/**
 * 这个人对这一类同意过没有。**不比对版本**，理由见 lib/consent.ts CONSENT_VERSIONS。
 */
export function hasConsent(db: Database, userId: number, kind: ConsentKind): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM consents WHERE user_id=? AND kind=? LIMIT 1')
    .get(userId, kind) as { hit: number } | undefined;
  return row !== undefined;
}

/** 最早那一次同意的时刻；没同意过回 null（页面用它显示「你在 X 时同意过」）。 */
export function consentAt(db: Database, userId: number, kind: ConsentKind): string | null {
  const row = db
    .prepare('SELECT at FROM consents WHERE user_id=? AND kind=? ORDER BY id ASC LIMIT 1')
    .get(userId, kind) as { at: string } | undefined;
  return row?.at ?? null;
}

/** 这个人所有同意过的类别（GET /api/v1/me 用它一次性交给设置页） */
export function consentedKinds(db: Database, userId: number): string[] {
  const rows = db
    .prepare('SELECT DISTINCT kind FROM consents WHERE user_id=? ORDER BY kind')
    .all(userId) as { kind: string }[];
  return rows.map((r) => r.kind);
}
