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
  /** 非空 = 这个人明确撤回过这一类（协议五.9）。读侧一律排除带值的行。 */
  revoked_at: string | null;
  revoke_note: string | null;
}

const COLUMNS = 'id, user_id, kind, version, at, ip_digest, revoked_at, revoke_note';

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
  if (res.changes > 0) return { created: true };
  // 这一版此前有行了。**如果那一行是撤回过的，本次重新同意要把它解除撤回**——
  // 不解除的形态是：用户在设置页把开关重新打开、页面回「已开启」，而闸门读到的仍是
  // 「撤回过」，于是功能照旧不工作，两边都不报错。撤回是可逆的（协议五.9 只说撤回，
  // 没说撤回之后不能再同意），所以重新同意必须能真的把它开回来。
  const undone = db
    .prepare(
      'UPDATE consents SET revoked_at = NULL, revoke_note = NULL WHERE user_id=? AND kind=? AND revoked_at IS NOT NULL',
    )
    .run(input.userId, input.kind);
  return { created: undone.changes > 0 };
}

/**
 * 这个人对这一类同意过没有。**不比对版本**，理由见 lib/consent.ts CONSENT_VERSIONS。
 */
export function hasConsent(db: Database, userId: number, kind: ConsentKind): boolean {
  // **撤回过的行不算数**（协议五.9）。把撤回判成另一个函数、让各处自己 && 一下的形态是：
  // 某一处只问了 hasConsent 就放行，于是一个撤回过的人在那条路上仍然被当成同意过的人，
  // 而那条路一切正常、什么都不报。闸门只有一个问题要回答：此刻他同意没有。
  const row = db
    .prepare('SELECT 1 AS hit FROM consents WHERE user_id=? AND kind=? AND revoked_at IS NULL LIMIT 1')
    .get(userId, kind) as { hit: number } | undefined;
  return row !== undefined;
}

/** 最早那一次同意的时刻；没同意过回 null（页面用它显示「你在 X 时同意过」）。 */
export function consentAt(db: Database, userId: number, kind: ConsentKind): string | null {
  const row = db
    .prepare('SELECT at FROM consents WHERE user_id=? AND kind=? AND revoked_at IS NULL ORDER BY id ASC LIMIT 1')
    .get(userId, kind) as { at: string } | undefined;
  return row?.at ?? null;
}

/** 这个人所有同意过的类别（GET /api/v1/me 用它一次性交给设置页） */
export function consentedKinds(db: Database, userId: number): string[] {
  const rows = db
    .prepare('SELECT DISTINCT kind FROM consents WHERE user_id=? AND revoked_at IS NULL ORDER BY kind')
    .all(userId) as { kind: string }[];
  return rows.map((r) => r.kind);
}

// ───────────────────────────── 撤回（协议五.9 / 附一第 7 项）─────────────────────────────
// 语义层（哪几项可撤、撤了会发生什么、回给用户的话）在 lib/lifecycle/consents.ts；
// 本节只管这张表怎么读怎么写——同一张表不许有第二个碰得着它的文件。

/** 这个人在这一类下最近的一行（撤回过的也返回，读的是「他做过什么」而不是「他同不同意」）。 */
export function findConsent(db: Database, userId: number, kind: ConsentKind): ConsentRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM consents WHERE user_id=? AND kind=? ORDER BY id DESC LIMIT 1`)
    .get(userId, kind) as ConsentRow | undefined;
}

/** 这个人名下所有同意行（含撤回过的），设置页那张卡按 kind 归拢。 */
export function listConsents(db: Database, userId: number): ConsentRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM consents WHERE user_id=? ORDER BY kind, id DESC`)
    .all(userId) as ConsentRow[];
}

/**
 * 这个人明确撤回过这一类没有。**"查不到行"不算撤回**（那是"从没表过态"）：
 * 两者的区别决定了要对用户说哪一句话——"你撤回过，去设置页可以重新打开"
 * 与"这件事还没问过你，现在问一次"是两回事。
 */
export function consentRevoked(db: Database, userId: number, kind: ConsentKind): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM consents WHERE user_id=? AND kind=? AND revoked_at IS NOT NULL LIMIT 1')
    .get(userId, kind) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * 撤回一项同意。**幂等**：再撤一次照样成功、首次撤回时刻不改写。
 *
 * 两句 SQL 各自原子，合起来的效果与顺序无关：
 *  ① 这一版还没有行时补一行「已撤回」——撤回的效力不能依赖"先有一条同意记录"，
 *     本表落地之前跑起来的功能没留下过任何同意行，而那些人恰恰最需要能把它关掉；
 *  ② 把这个人这一类下所有还没撤的行一次性盖上时刻——同一类可能有多版（每版一行），
 *     只盖最新那一行的形态是：老版本那行仍然 revoked_at IS NULL，于是 hasConsent 照样回 true。
 *
 * @returns false = 之前就全撤过了（本次没有任何一行发生变化）。
 */
export function revokeConsent(
  db: Database,
  input: { userId: number; kind: ConsentKind; now: string; note?: string | null; version?: string },
): boolean {
  const version = input.version ?? CONSENT_VERSIONS[input.kind];
  const note = input.note ?? null;
  const inserted = db
    .prepare(
      'INSERT OR IGNORE INTO consents (user_id, kind, version, at, revoked_at, revoke_note) VALUES (?,?,?,?,?,?)',
    )
    .run(input.userId, input.kind, version, input.now, input.now, note);
  const updated = db
    .prepare(
      'UPDATE consents SET revoked_at=?, revoke_note=COALESCE(?, revoke_note) WHERE user_id=? AND kind=? AND revoked_at IS NULL',
    )
    .run(input.now, note, input.userId, input.kind);
  return inserted.changes + updated.changes > 0;
}

/** 这一类最早那一次撤回的时刻；没撤过回 null（设置页显示「你在 X 时撤回过」）。 */
export function revokedAt(db: Database, userId: number, kind: ConsentKind): string | null {
  const row = db
    .prepare(
      'SELECT revoked_at FROM consents WHERE user_id=? AND kind=? AND revoked_at IS NOT NULL ORDER BY revoked_at ASC LIMIT 1',
    )
    .get(userId, kind) as { revoked_at: string } | undefined;
  return row?.revoked_at ?? null;
}
