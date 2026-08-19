// app/src/lib/billing/redeem.ts
// 兑换码核销：原子认领（CAS 防并发重放）+ 公道值入账（gongdao_ledger 事实源）+ 幂等兜底。
import type Database from 'better-sqlite3';
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
