// app/src/lib/admin/users.ts
// 后台账号列表与检索。**出口只出掩码手机号**——本文件是手机号在后台面上的唯一渲染点。
//
// ── 手机号：只显尾 4，且不存在「全显」这个开关 ──
// 后台是老板面板，不是免检区：一张能一眼看全站手机号的表，泄露成本与库被拖走等价
//（而它比库好拿——一次会话劫持就够）。客服核对身份用尾 4 已经够，尾 4 也是电话里
// 让对方报的那 4 位。所以 maskTail4 是**函数的返回值本身**，不是一个可以传参关掉的选项：
// 没有开关，就没有「谁在什么条件下会打开它」这个问题。
// 判据：__tests__ 断言列表出参里不含 11 位连续数字（变异成全显即红）。
//
// ── 检索：手机号只支持全号，因为库里根本没有可模糊匹配的东西 ──
// phone_enc 是 AES-GCM 密文（每次 iv 随机，同一个号两次加密不同串），LIKE 它等于 LIKE 随机数。
// 可等值查询的只有 phone_hash = HMAC(归一化手机号)，HMAC 没有前缀关系，
// 所以「138 开头的用户」这种查询在本库上**不可能实现**，不是没做。
// 这个限制要写在 UI 上（见 AdminUsersView 的说明行）：不写的话，搜不出来会被读成「没这个人」。
import type Database from 'better-sqlite3';

import { normalizePhone } from '@/lib/auth/phone';
import { decryptField, hashLookup } from '@/lib/crypto';

/** 检索字段。**不做「自动猜」**：uid 与手机号都是纯数字串，猜错的那次会静默给出错误结果。 */
export const ADMIN_SEARCH_FIELD = ['uid', 'email', 'phone'] as const;
export type AdminSearchField = (typeof ADMIN_SEARCH_FIELD)[number];

export interface AdminUserRow {
  uid: number;
  email: string | null;
  /** 只显尾 4，形如 `****8888`；没绑手机或解不开 → null（不回落明文） */
  phone_masked: string | null;
  created_at: string;
  auth_status: string;
  /** 当前有效会员档；无有效会员 → null（不给「无」这类占位串） */
  plan: string | null;
  plan_expires_at: string | null;
  balance: number;
  case_count: number;
}

export interface AdminUserPage {
  rows: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  /** 检索词本身不合法（如手机号格式不对）时给一句人话，页面照常出空表 */
  hint: string | null;
}

export const ADMIN_PAGE_SIZE = 20;

/**
 * 手机号掩码：只留尾 4。
 * 解不开（密钥轮换过、密文损坏）返回 null——**绝不回落明文**，也不抛：
 * 一个用户的密文坏掉不该让整张后台表打不开。
 */
export function maskPhoneTail4(phoneEnc: string | null): string | null {
  if (!phoneEnc) return null;
  try {
    const phone = decryptField(phoneEnc);
    return phone.length >= 4 ? `****${phone.slice(-4)}` : '****';
  } catch {
    return null;
  }
}

/** LIKE 子串检索里的元字符转义（用户输入的 `%` 不该变成「匹配全部」）。 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Where {
  sql: string;
  params: unknown[];
  hint: string | null;
}

/** 把检索词翻成 WHERE 片段。空词 = 不过滤（全量列表）。 */
function buildWhere(field: AdminSearchField, query: string): Where {
  const q = query.trim();
  if (!q) return { sql: '1=1', params: [], hint: null };

  if (field === 'uid') {
    if (!/^\d+$/.test(q)) return { sql: '1=0', params: [], hint: 'UID 只能是数字' };
    return { sql: 'u.id = ?', params: [Number(q)], hint: null };
  }

  if (field === 'email') {
    return { sql: "u.email LIKE ? ESCAPE '\\'", params: [`%${escapeLike(q)}%`], hint: null };
  }

  // phone：必须全号。归一化失败就明说「格式不对」，别让它和「查无此人」同形。
  const phone = normalizePhone(q);
  if (!phone) {
    return { sql: '1=0', params: [], hint: '手机号要填 11 位全号（加密存储，不支持模糊匹配）' };
  }
  return { sql: 'u.phone_hash = ?', params: [hashLookup(phone)], hint: null };
}

/**
 * 账号列表（倒序，新注册在前）+ 检索 + 分页。
 * 会员档与到期取「有效行里 expires_at 最大的那条」，与 getMembership 同口径。
 */
export function listAdminUsers(
  db: Database.Database,
  opts: { field?: AdminSearchField; query?: string; page?: number; pageSize?: number } = {},
): AdminUserPage {
  const field = opts.field ?? 'uid';
  const pageSize = Math.max(1, Math.min(100, Math.trunc(opts.pageSize ?? ADMIN_PAGE_SIZE)));
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const where = buildWhere(field, opts.query ?? '');

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE ${where.sql}`).get(...where.params) as {
      c: number;
    }
  ).c;

  const rows = db
    .prepare(
      `SELECT u.id           AS uid,
              u.email        AS email,
              u.phone_enc    AS phone_enc,
              u.created_at   AS created_at,
              u.auth_status  AS auth_status,
              COALESCE(g.balance, 0) AS balance,
              (SELECT COUNT(*) FROM cases c WHERE c.user_id = u.id) AS case_count,
              (SELECT m.plan FROM memberships m
                 WHERE m.user_id = u.id AND m.expires_at > datetime('now')
                 ORDER BY m.expires_at DESC LIMIT 1) AS plan,
              (SELECT MAX(m.expires_at) FROM memberships m
                 WHERE m.user_id = u.id AND m.expires_at > datetime('now')) AS plan_expires_at
         FROM users u
         LEFT JOIN gongdao g ON g.user_id = u.id
        WHERE ${where.sql}
        ORDER BY u.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...where.params, pageSize, (page - 1) * pageSize) as (Omit<AdminUserRow, 'phone_masked'> & {
    phone_enc: string | null;
  })[];

  return {
    rows: rows.map(({ phone_enc, ...r }) => ({ ...r, phone_masked: maskPhoneTail4(phone_enc) })),
    total,
    page,
    pageSize,
    hint: where.hint,
  };
}

/** 单个账号（详情面板用）。查无此人 → null。 */
export function getAdminUser(db: Database.Database, uid: number): AdminUserRow | null {
  const page = listAdminUsers(db, { field: 'uid', query: String(uid), pageSize: 1 });
  return page.rows[0] ?? null;
}
