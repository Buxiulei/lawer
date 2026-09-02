// app/src/lib/admin/auth.ts
// 管理后台鉴权闸门（唯一入口）。
//
// ⚠️ 【并行实现，合并轮收敛为一】ws/redeem-codes 单同期在做兑换码管理页（今在 /woo/codes），
// 其中另有一份 ADMIN_UIDS 鉴权实现。两支的**接口约定一致**：
//     登录态 uid ∈ env ADMIN_UIDS（逗号白名单） → 放行；
//     其余一律 404（不 401 不 403），不暴露后台存在；
//     ADMIN_UIDS 空/未配 = 全拒（不是全放）。
// 合并时两份收敛成这一份（或那一份），**不许两份并存**——鉴权有两个实现，
// 就等于「哪一份说了算」取决于谁先被 import，而这条路后面接的是发钱。
//
// ── 为什么是 404 不是 403 ──
// 403 等于对着未授权的人承认「这里确实有个后台，只是你进不来」。后台是老板面板，
// 它的存在本身就是情报：知道有 /admin/users 的人才会去猜参数、扫子路径、试越权。
// 回 404 让「路径不存在」与「你不是管理员」在响应上完全同形——**空体 404**，
// 与随便敲一个不存在的地址（Next 未匹配路由）逐字一致：状态 404、体为空，
// 不带任何 error_code/文案（error_code 本身就是「这是一个真实存在的处理器」的证据）。
// 因此也不能靠响应差异做用户枚举。
//（合并轮裁决：与 /admin/codes 签发面统一为空体 404，见 lib/auth/api-key 的同级纪律。）
//
// ── 为什么额外要求网页登录态（via='jwt'）──
// api key 是用户自己在设置页里签发的长期凭据（lib/auth/api-key），拿去给自己的 agent 用。
// 管理员本人的一把 case:read key 若能调这条线，就等于「一把泄露的只读 key 能发无限公道值」。
// 同一条纪律在 lib/auth/guard.requireWebSession 上已有先例（"不能用 key 再造 key"），
// 发钱面至少与之同级。这是在 uid 白名单**之上**的加严，不改上面那条对外约定：
// 非白名单照旧 404，api key 走到这里同样 404（不另给错误码，免得测出后台存在）。
import { NextResponse } from 'next/server';
import type { Database } from 'better-sqlite3';

import { resolveIdentity, type Identity } from '@/lib/auth/identity';

/** 白名单环境变量名。值形如 `2,17,33`（逗号分隔的 uid）。 */
export const ADMIN_UIDS_ENV = 'ADMIN_UIDS';

export type AdminGuardResult =
  | { ok: true; identity: Identity }
  | { ok: false; response: NextResponse };

/**
 * 唯一的失败出口：**空体 404**，与随便敲一个不存在的地址完全同形。
 * 每次都新建 NextResponse（Response 体只能读一次，共享单例会在第二个请求上炸）。
 */
function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

/**
 * 解析白名单。**未配置或空串一律得到空集 = 全拒**。
 *
 * 这条默认方向是有意选的：漏配 env 的后果只能二选一——要么谁都进不去（运维发现，
 * 补一行配置），要么谁都进得去（没人发现，直到有人发现）。后者的代价是整站的钱。
 * 非数字、非正整数的碎片直接丢弃，不让 `ADMIN_UIDS=2,,x` 里的空洞变成一个 NaN 通配。
 */
export function adminUids(env: Record<string, string | undefined> = process.env): number[] {
  const raw = env[ADMIN_UIDS_ENV] ?? '';
  const uids: number[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const uid = Number(trimmed);
    if (uid > 0 && !uids.includes(uid)) uids.push(uid);
  }
  return uids;
}

/** 这个 uid 是不是管理员。白名单空 → 恒 false。 */
export function isAdminUid(uid: number, env: Record<string, string | undefined> = process.env): boolean {
  return adminUids(env).includes(uid);
}

/**
 * 管理后台路由的统一闸门。过了给 Identity，没过给一个可直接 return 的 404。
 * 调用方不得自己再判白名单——判两次就有两套口径。
 */
export function requireAdmin(db: Database, req: Request): AdminGuardResult {
  const identity = resolveIdentity(db, req.headers);
  if (!identity) return { ok: false, response: notFound() };
  if (identity.via !== 'jwt') return { ok: false, response: notFound() };
  if (!isAdminUid(identity.uid)) return { ok: false, response: notFound() };
  return { ok: true, identity };
}

/** 后台里的「这条记录不存在」也走同一个 404 形状（如目标 uid 查无此人）。 */
export function adminNotFound(): NextResponse {
  return notFound();
}

/** 后台的入参校验失败（400）。形状与全站错误包一致。 */
export function adminBadRequest(errorCode: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error_code: errorCode, message }, { status: 400 });
}
