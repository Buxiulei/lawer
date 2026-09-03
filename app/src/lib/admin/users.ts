// app/src/lib/admin/users.ts
// 后台账号列表与检索。**手机号在这里解密成 11 位全号出网**——本文件是手机号在后台面上的唯一渲染点。
//
// ── 手机号：全显，因为这张表的用途就是"照着号码找人" ──
// 这一页此前只出尾 4，理由写着「后台不是免检区」。主理人 2026-09-03 推翻：
// 「手机号不要脱敏，这是管理后台」。掩码在这里挡不住任何攻击者——能打开这一页的人
// 已经通过了 ADMIN_UIDS 白名单 + 网页登录态（lib/admin/auth），而库本身也在他手上；
// 掩码真正拦住的只有正当用途：客服拿到一个尾 4 打不出电话，运营核对不了工单里的号码。
// 所以全显，代价由**入口**承担（白名单、非白名单空体 404、api key 进不来），不由渲染层承担。
//
// 解不开的那一行不静默变成 '—'：`phone` 给 null 的同时 `phone_error` 给出**原话**
//（decryptField 的报错本身就是自述式的：缺 env LAWER_DATA_KEY / 密文认证失败…）。
// 「没绑手机」与「密钥配错了」在页面上必须长得不一样——否则密钥轮换出事那天，
// 后台看起来只是"这些人都没绑手机"。
//
// ── 检索：全号走 hash 精确，≤10 位数字走解密后子串匹配 ──
// phone_enc 是 AES-GCM 密文（每次 iv 随机），LIKE 它等于 LIKE 随机数；
// phone_hash 是 HMAC，没有前缀关系。所以「138 开头」这种查询**在 SQL 里不可能实现**。
// 但它在应用层可能：把绑了手机的账号取出来逐行解密再 includes。用户量小（几千），
// 一次全表解密扫描是可以接受的代价 —— 上限 PHONE_SCAN_LIMIT 行，
// 到顶了要在 hint 里说出来，绝不静默漏检（漏检与"查无此人"同形，那是最坏的一种错）。
import type Database from 'better-sqlite3';

import { normalizePhone } from '@/lib/auth/phone';
import { decryptField, hashLookup } from '@/lib/crypto';

/** 检索字段。**不做「自动猜」**：uid 与手机号都是纯数字串，猜错的那次会静默给出错误结果。 */
export const ADMIN_SEARCH_FIELD = ['uid', 'email', 'phone'] as const;
export type AdminSearchField = (typeof ADMIN_SEARCH_FIELD)[number];

/**
 * 手机模糊检索一次最多解密多少行。
 * 超过这个数就只扫最近注册的这些，并在 hint 里说清"只扫了多少"——
 * 静默漏检会被读成「没这个人」，那比"查得慢"严重得多。
 */
export const PHONE_SCAN_LIMIT = 5000;

/** 模糊检索接受的最长数字串。11 位是全号，走 hash 精确，不进这条路。 */
const PHONE_FUZZY_MAX = 10;

export interface AdminUserRow {
  uid: number;
  email: string | null;
  /** 11 位全号明文；没绑手机 → null；解不开 → null 且 phone_error 非空 */
  phone: string | null;
  /** 解密失败的原因原文（自述式）；正常行为 null */
  phone_error: string | null;
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
  /** 检索词本身不合法、或模糊扫描到顶时给一句人话；页面照常出表 */
  hint: string | null;
}

export const ADMIN_PAGE_SIZE = 20;

/**
 * 解出手机号全号。
 *
 * 解不开时**返回原因，不吞**：吞掉就只剩一个 null，而 null 已经被"没绑手机"占用了。
 * 也不抛：一个用户的密文坏掉不该让整张后台表打不开。
 */
export function decryptPhoneFull(phoneEnc: string | null): {
  phone: string | null;
  error: string | null;
} {
  if (!phoneEnc) return { phone: null, error: null };
  try {
    return { phone: decryptField(phoneEnc), error: null };
  } catch (err) {
    return { phone: null, error: err instanceof Error ? err.message : String(err) };
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
  /**
   * 非空 = 这次检索**没法用一条 WHERE 表达**：要在应用层解密后按子串匹配。
   * buildWhere 的其余分支都假设"结果集能整个塞进 SQL"，这一条打破了那个假设，
   * 所以由 listAdminUsers 显式分叉，而不是在这里硬拼一个假的 sql。
   */
  fuzzyDigits?: string;
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

  // phone：全号先走 hash 等值（唯一、O(1)、不用解密任何一行）。
  const phone = normalizePhone(q);
  if (phone) return { sql: 'u.phone_hash = ?', params: [hashLookup(phone)], hint: null };

  // 归一化不成的纯数字串（1–10 位）当"号码片段"处理，走解密扫描。
  // **注意分流条件是 normalizePhone 失败**：将来谁把 normalizePhone 放宽到接受 10 位，
  // 这里就会静默改走 hash 精确、模糊检索悄悄失效——判据里专门盯着这条边界。
  const digits = q.replace(/[\s-]/g, '');
  if (new RegExp(`^\\d{1,${PHONE_FUZZY_MAX}}$`).test(digits)) {
    return { sql: '1=1', params: [], hint: null, fuzzyDigits: digits };
  }

  return {
    sql: '1=0',
    params: [],
    hint: `手机号请填 11 位全号（精确），或 1–${PHONE_FUZZY_MAX} 位数字片段（模糊）`,
  };
}

const ROW_SELECT = `SELECT u.id           AS uid,
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
         LEFT JOIN gongdao g ON g.user_id = u.id`;

type RawRow = Omit<AdminUserRow, 'phone' | 'phone_error'> & { phone_enc: string | null };

/** 取一页行并把 phone_enc 换成明文/错因。**phone_enc 恒不随行出网**（解构剔除，不是覆盖）。 */
function selectRows(
  db: Database.Database,
  whereSql: string,
  params: unknown[],
  limit: number,
  offset: number,
): AdminUserRow[] {
  const rows = db
    .prepare(`${ROW_SELECT} WHERE ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as RawRow[];
  return rows.map(({ phone_enc, ...r }) => {
    const { phone, error } = decryptPhoneFull(phone_enc);
    return { ...r, phone, phone_error: error };
  });
}

/**
 * 手机号片段检索：取最近 PHONE_SCAN_LIMIT 个绑了手机的账号，逐行解密后按包含匹配。
 *
 * 多取一行（LIMIT n+1）来判"是不是还有更多"——用命中数去判会判错：
 * 扫了 5000 行只命中 3 个，也照样漏掉了第 5001 行以后的人。
 * 解不开的行跳过（不中断整次检索），它们在全量列表里仍会带着 phone_error 现身。
 */
function fuzzyPhonePage(
  db: Database.Database,
  digits: string,
  page: number,
  pageSize: number,
): AdminUserPage {
  const scanned = db
    .prepare('SELECT id, phone_enc FROM users WHERE phone_enc IS NOT NULL ORDER BY id DESC LIMIT ?')
    .all(PHONE_SCAN_LIMIT + 1) as { id: number; phone_enc: string }[];
  const truncated = scanned.length > PHONE_SCAN_LIMIT;

  const uids: number[] = [];
  for (const r of scanned.slice(0, PHONE_SCAN_LIMIT)) {
    const { phone } = decryptPhoneFull(r.phone_enc);
    if (phone && phone.includes(digits)) uids.push(r.id);
  }

  const slice = uids.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  const rows = slice.length
    ? selectRows(db, `u.id IN (${slice.map(() => '?').join(',')})`, slice, pageSize, 0)
    : [];

  return {
    rows,
    total: uids.length,
    page,
    pageSize,
    hint: truncated
      ? `号码片段检索只扫描了最近 ${PHONE_SCAN_LIMIT} 个绑定手机的账号，更早的账号不在这次结果里。要确保查全，请用 11 位全号。`
      : null,
  };
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

  if (where.fuzzyDigits) return fuzzyPhonePage(db, where.fuzzyDigits, page, pageSize);

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE ${where.sql}`).get(...where.params) as {
      c: number;
    }
  ).c;

  return {
    rows: selectRows(db, where.sql, where.params, pageSize, (page - 1) * pageSize),
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
