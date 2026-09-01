// app/src/lib/auth/admin.ts
// 管理后台白名单：env ADMIN_UIDS 里逗号分隔的 uid 才是管理员。
//
// 【为什么是 env 不是库里一张 is_admin 列】管理员这件事必须**改配置 + 重启**才能变，
// 不能靠一条 UPDATE。库是应用自己写得动的东西：任何一条能写 users 表的注入/越权，
// 顺手把自己设成管理员就拿到了凭空造公道值的能力。env 在应用的写权限之外。
//
// 【为什么默认是空集，不是「没配就放行」】漏配 ADMIN_UIDS 时，
// 「谁都不是管理员」的现象是后台 404、有人来问；「谁都是管理员」的现象是**一切正常**。
// 两种错误里只有前者会被发现。

/** 解析 env ADMIN_UIDS；没配、配空、全是垃圾值，一律得到空集。 */
export function adminUids(raw: string | undefined = process.env.ADMIN_UIDS): ReadonlySet<number> {
  const out = new Set<number>();
  for (const part of (raw ?? '').split(',')) {
    const t = part.trim();
    // 只认纯正整数字面量。`Number(' 2 ')`=2 但 `Number('2x')`=NaN、`Number('')`=0——
    // 那个 0 会悄悄把「配了个空段」变成「uid 0 是管理员」，故不走 Number 的宽松解析。
    if (/^\d+$/.test(t) && Number(t) > 0) out.add(Number(t));
  }
  return out;
}

/** 这个 uid 是不是管理员。 */
export function isAdminUid(uid: number, raw?: string): boolean {
  return adminUids(raw).has(uid);
}
