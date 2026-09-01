// app/src/lib/auth/admin.ts
//
// ⚠️ 【本份是临时的：合并轮删本份、归口 `lib/admin/auth.ts`】
// 兄弟支 ws/admin-console 已经把管理后台鉴权收敛成唯一入口 `app/src/lib/admin/auth.ts`，
// 并就 `via==='jwt'` 这个洞做过成文裁决——那一份是真源。它此刻还没并进 main，
// 本支若直接 import 会引一个不存在的文件，所以先留这一份**签名逐字对齐**的替身：
//   adminUids(env) / isAdminUid(uid, env) / requireAdmin(db, req) / AdminGuardResult
// 合并轮的动作是**删掉本文件**、把 `@/lib/auth/admin` 改成 `@/lib/admin/auth`，不改调用处代码。
// 唯一有意的差异是 404 的**响应体**：本支给空体（与 Next 未匹配路由同形），
// 兄弟支给 JSON 错误包；两种 404 的取舍留到合并轮统一裁，不在这里各改各的。
// 【不许并存】鉴权有两个实现，等于「哪一份说了算」取决于谁先被 import，而这条路后面接的是发钱。
//
// ── 为什么是 env 不是库里一张 is_admin 列 ──
// 管理员这件事必须**改配置 + 重启**才能变，不能靠一条 UPDATE。库是应用自己写得动的东西：
// 任何一条能写 users 表的注入/越权，顺手把自己设成管理员就拿到了凭空造公道值的能力。
// env 在应用的写权限之外。
//
// ── 为什么默认是空集，不是「没配就放行」 ──
// 漏配 ADMIN_UIDS 时，「谁都不是管理员」的现象是后台 404、有人来问；
// 「谁都是管理员」的现象是**一切正常**。两种错误里只有前者会被发现。
//
// ── 为什么额外要求网页登录态（via='jwt'）──
// api key 是用户自己在设置页里签发的长期凭据（lib/auth/api-key），拿去给自己的 agent 用。
// 管理员本人的一把 case:read key 若能调签发面，就等于「一把泄露的只读 key 能发无限公道值」——
// 而这条路造出来的是**凭空的**余额，不是从谁账上挪的，对账也发现不了「本不该发」。
// 同一条纪律在 lib/auth/guard.requireWebSession 上已有先例（"api key 不得自我增殖：不能用 key 再造 key"），
// 发钱面至少与造 key 同级。这是在 uid 白名单**之上**的加严，不改对外约定：
// 非白名单照旧 404，api key 走到这里同样 404（不另给错误码，免得测出后台存在）。
import { NextResponse } from 'next/server';
import type { Database } from 'better-sqlite3';

import { resolveIdentity, type Identity } from './identity';

/** 白名单环境变量名。值形如 `2,17,33`（逗号分隔的 uid）。 */
export const ADMIN_UIDS_ENV = 'ADMIN_UIDS';

export type AdminGuardResult =
  | { ok: true; identity: Identity }
  | { ok: false; response: NextResponse };

/**
 * 唯一的失败出口：**空体 404**，与随便敲一个不存在的地址完全同形。
 *
 * 403 等于承认「这里有个后台，只是你进不去」——那正是值得花时间撞的东西。
 * 四种人拿到的东西必须一模一样：没登录的、登录了但不在白名单的、拿 api key 来的、随便试地址的。
 * 所以不区分 401/403，也不回任何 error_code（error_code 本身就是「路由存在」的证据）。
 * 每次都新建 NextResponse（Response 体只能读一次，共享单例会在第二个请求上炸）。
 */
function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

/**
 * 解析白名单。**未配置或空串一律得到空集 = 全拒**。
 *
 * 非纯数字、0、负数、小数、科学计数法的碎片一律丢弃：用 Number 做宽松解析时
 * `Number('')===0`，`ADMIN_UIDS=","` 里的空段会解出一个 uid 0 落进白名单，
 * 让「配错了」和「配对了」在测试里同形。
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
 * 管理后台路由的统一闸门。过了给 Identity，没过给一个可直接 return 的空体 404。
 * 调用方不得自己再判白名单、也不得自己再判 via——判两次就有两套口径。
 */
export function requireAdmin(db: Database, req: Request): AdminGuardResult {
  const identity = resolveIdentity(db, req.headers);
  if (!identity) return { ok: false, response: notFound() };
  if (identity.via !== 'jwt') return { ok: false, response: notFound() };
  if (!isAdminUid(identity.uid)) return { ok: false, response: notFound() };
  return { ok: true, identity };
}
