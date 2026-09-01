// app/src/lib/billing/redeem.ts
// 兑换码：签发（管理后台/CLI 共用）+ 核销（原子认领 CAS 防并发重放 + 公道值入账走
// gongdao_ledger 事实源 + 幂等兜底）+ 按账号的失败限速。
import crypto from 'node:crypto';

import type Database from 'better-sqlite3';
import { countIpEventsSince, recordIpEvent } from '../db/ip-quota';
import { toSql } from '../db/time';
import { getGongdao, gongdaoGrant } from './index';
import { GONGDAO_LEDGER_TYPE } from './pricing';

export type RedeemResult =
  | { ok: true; gongdao: number; balance: number }
  | { ok: false; reason: 'not_found' | 'disabled' | 'expired' | 'used' };

const REASON_TEXT: Record<Exclude<RedeemResult, { ok: true }>['reason'], string> = {
  not_found: '兑换码不存在',
  disabled: '兑换码已停用',
  expired: '兑换码已过期',
  used: '兑换码已被使用',
};

export function redeemReasonText(reason: Exclude<RedeemResult, { ok: true }>['reason']): string {
  return REASON_TEXT[reason];
}

// ───────────────────────────── 签发 ─────────────────────────────

/**
 * 码的字母表：base32 去掉全部易混字符。
 *
 * 去掉的是 `0 O` / `1 I L` / `U`（读作「you」易与 V 混），剩 30 个。
 * 【为什么不凑成 32 让取模干净】码是要**用嘴念、用手抄**的：活动现场把 `0` 念成 `O`、
 * 把 `1` 抄成 `I`，用户会得到一条「兑换码无效」——而那条提示按设计是模糊的，
 * 他无从知道自己只是抄错了一位。少两个字符换来「念得清」，取模的偏置另用拒绝采样解决。
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 码长。30^16 ≈ 2^78 —— 不可枚举是这个功能的**唯一防线**：
 * 猜中一条码就是凭空拿到一笔公道值，而猜测发生在别人的账号上，限速拦不住分布式撞库。
 */
export const CODE_LENGTH = 16;

/** 拒绝采样的阈值：256 除以 30 的整数倍（8×30=240），≥240 的字节丢弃重取。 */
const REJECT_AT = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

/**
 * 生成一条码（已是归一形：全大写、无分隔符）。
 *
 * 【为什么要拒绝采样，不直接 `byte % 30`】256 不是 30 的整数倍，直接取模会让前 16 个字符
 * 出现的概率比后 14 个高 12.5%。这不会让任何测试变红，也不会让任何码看起来不对——
 * 它只是悄悄把熵从 78 位削下去一截。丢掉 ≥240 的字节即可完全消除偏置，代价是平均多取 6% 的字节。
 */
export function generateRedeemCode(length: number = CODE_LENGTH): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const b of bytes) {
      if (b >= REJECT_AT) continue;
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export interface IssueCodesParams {
  /** 张数 */
  count: number;
  /** 单张面值（公道值） */
  gongdaoValue: number;
  /** 批次备注，给事后审计看「这批是为什么发的」 */
  note?: string | null;
  /** 签发人 uid（CLI 无登录态时给 null） */
  createdBy?: number | null;
  /** 到期时间，canonical 串（lib/db/time 的 toSql 产出）；不填＝不过期 */
  expiresAt?: string | null;
}

/**
 * 批量签发兑换码，返回明文码列表（**只在这一次返回**：库里存的就是明文码，
 * 但列表页只回显它，不再另发一次）。
 *
 * 【UNIQUE 撞了就重取，不是失败】code 上有唯一索引。30^16 的空间里撞一次是天文数字级的
 * 小概率，但一旦撞上，「整批签发失败」对运营是个无从理解的错误。重取三次仍撞才抛——
 * 那种情况下问题不是运气，是随机源坏了，必须炸出来而不是继续发码。
 */
export function issueRedeemCodes(db: Database.Database, params: IssueCodesParams): string[] {
  const count = Math.trunc(params.count);
  const value = Math.trunc(params.gongdaoValue);
  if (!Number.isFinite(count) || count < 1) throw new Error('签发张数必须是正整数');
  if (!Number.isFinite(value) || value < 1) throw new Error('面值必须是正整数（公道值只增不减地记账，0 张码没有意义）');

  const insert = db.prepare(
    'INSERT INTO redemption_codes (code, gongdao_value, note, created_by, expires_at) VALUES (?,?,?,?,?)',
  );

  return db.transaction(() => {
    const codes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      let inserted = false;
      for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
        const code = generateRedeemCode();
        try {
          insert.run(code, value, params.note ?? null, params.createdBy ?? null, params.expiresAt ?? null);
          codes.push(code);
          inserted = true;
        } catch (err) {
          // 只吞唯一约束冲突；别的错（磁盘满、外键、表不存在）必须原样抛出
          if (!/UNIQUE constraint failed/i.test(String((err as Error).message))) throw err;
        }
      }
      if (!inserted) throw new Error('连续三次生成的兑换码都与既有码重复——随机源异常，本批未签发');
    }
    return codes;
  })();
}

export interface RedeemCodeRow {
  id: number;
  code: string;
  gongdao_value: number;
  note: string | null;
  enabled: number;
  expires_at: string | null;
  redeemed_by: number | null;
  redeemed_at: string | null;
  created_at: string;
}

/** 管理页列表：最新签发的在前。 */
export function listRedeemCodes(db: Database.Database, limit = 200): RedeemCodeRow[] {
  return db
    .prepare(
      `SELECT id, code, gongdao_value, note, enabled, expires_at, redeemed_by, redeemed_at, created_at
         FROM redemption_codes ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, Math.trunc(limit)))) as RedeemCodeRow[];
}

// ───────────────────────────── 失败限速 ─────────────────────────────

/** 每账号每小时允许的失败次数；第 10 次失败之后这个账号一小时内兑不了任何码。 */
export const REDEEM_FAIL_MAX = 10;
const REDEEM_FAIL_WINDOW_MS = 60 * 60 * 1000;
/** 旧行多留一倍，留出「他说他被锁了」时可查的余量（同 lib/auth/ip-quota 的口径）。 */
const REDEEM_FAIL_RETENTION_MS = 2 * REDEEM_FAIL_WINDOW_MS;

/**
 * 失败计数寄存在 ip_quota_events 里，键是 `redeem-fail:<uid>` 而不是 IP。
 *
 * 【为什么按账号不按 IP】这条限速防的是**枚举码**，不是防注册。攻击者换 IP 的成本近乎为零
 * （手机流量随便切），换账号却要走一遍注册+验证码。而合法用户从公司同一个 NAT 出口上来，
 * 按 IP 计数会让一屋子人共用 10 次额度——限速恰好在人最多的时候误伤最狠。
 *
 * 【为什么复用 ip_quota_events 而不是新建表】这张表的形状就是「(键, 时间) 只追加 + 写侧机会式
 * GC」，正是这里要的；countIpEventsSince/recordIpEvent 也只按键过滤，两种用途互不干扰
 * （GC 只删同键的行）。前缀带冒号，与任何真实 IP 字面量都不可能相等。
 */
function failKey(userId: number): string {
  return `redeem-fail:${userId}`;
}

/** 这个账号当前是否处在失败锁里。 */
export function isRedeemLocked(db: Database.Database, userId: number, now: Date = new Date()): boolean {
  const since = toSql(new Date(now.getTime() - REDEEM_FAIL_WINDOW_MS));
  return countIpEventsSince(db, failKey(userId), since) >= REDEEM_FAIL_MAX;
}

/** 记一次失败（只在核销失败时调用，成功不记——正常用户兑一张码不该消耗额度）。 */
export function recordRedeemFailure(db: Database.Database, userId: number, now: Date = new Date()): void {
  recordIpEvent(db, {
    ip: failKey(userId),
    createdAt: toSql(now),
    gcBeforeIso: toSql(new Date(now.getTime() - REDEEM_FAIL_RETENTION_MS)),
  });
}

/**
 * 核销兑换码：给 userId 增加面值公道值。
 * 校验顺序：存在 → 启用 → 过期 → 未被兑换。核心认领用 CAS（WHERE redeemed_by IS NULL），
 * 并发下仅一个请求成功，其余返回 used；入账走 gongdaoGrant（ledger 事实源，
 * (兑换, redeem-<id>) 唯一索引二次兜底）。
 */
export function redeemCode(db: Database.Database, userId: number, rawCode: string): RedeemResult {
  const code = rawCode.trim().toUpperCase();
  // 过期判定在 SQL 侧算（ADR-002）：canonical 串是 UTC，而 JS 的 new Date('YYYY-MM-DD HH:MM:SS')
  // 按本机时区解析，在 UTC+8 上会把有效期整整搬走 8 小时。datetime() 顺带归一存量的 ISO 串。
  const row = db.prepare(
    `SELECT id, gongdao_value, redeemed_by, enabled,
            (expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')) AS expired
       FROM redemption_codes WHERE code=?`,
  ).get(code) as
    | { id: number; gongdao_value: number; redeemed_by: number | null; enabled: number; expired: number }
    | undefined;

  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.enabled) return { ok: false, reason: 'disabled' };
  if (row.redeemed_by != null) return { ok: false, reason: 'used' };
  if (row.expired) return { ok: false, reason: 'expired' };

  const faceValue = row.gongdao_value;

  let balance = 0;
  const claimed = db.transaction(() => {
    const claim = db.prepare(
      "UPDATE redemption_codes SET redeemed_by=?, redeemed_at=datetime('now') WHERE id=? AND redeemed_by IS NULL",
    ).run(userId, row.id);
    if (claim.changes === 0) return false; // 并发下已被他人认领
    gongdaoGrant(userId, faceValue, GONGDAO_LEDGER_TYPE.redemption, `redeem-${row.id}`, { code }, db);
    balance = getGongdao(userId, db);
    return true;
  })();

  if (!claimed) return { ok: false, reason: 'used' };
  return { ok: true, gongdao: faceValue, balance };
}
