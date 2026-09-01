// app/src/app/api/v1/admin/users/route.ts
// GET /api/v1/admin/users  后台账号列表 + 检索 + 分页。
// 鉴权唯一入口是 lib/admin/auth 的 requireAdmin：非白名单一律 404（连后台存在都不承认）。
// 手机号在 lib/admin/users 服务端就掩成尾 4 才出网——前端截等于完整号在响应里躺过一次
//（浏览器缓存、代理日志、devtools 全都留痕），同 /api/v1/me 那条纪律。
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/auth';
import {
  ADMIN_SEARCH_FIELD,
  listAdminUsers,
  type AdminSearchField,
} from '@/lib/admin/users';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request) {
  const guard = requireAdmin(getDb(), req);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const rawField = url.searchParams.get('field') ?? 'uid';
  // 认不出的 field 退到 uid（而不是报错）：这是个只读列表，用户看得见自己选的是哪一栏。
  const field: AdminSearchField = (ADMIN_SEARCH_FIELD as readonly string[]).includes(rawField)
    ? (rawField as AdminSearchField)
    : 'uid';
  const page = Number(url.searchParams.get('page') ?? '1');

  const result = listAdminUsers(getDb(), {
    field,
    query: url.searchParams.get('q') ?? '',
    page: Number.isFinite(page) ? page : 1,
  });

  // self_uid：前端要拿它给发公道值的幂等键打前缀（op_ref 必须是本操作者的操作痕）。
  // 由服务端给而不是前端猜——前端手上只有一个不透明的 token，猜出来的 uid 会被路由拒掉，
  // 而那个失败只在"点了发放"那一刻才现形。
  return NextResponse.json({ ok: true, ...result, self_uid: guard.identity.uid });
}
