// app/src/app/api/v1/admin/codes/route.ts
// 管理后台的兑换码面：GET 列表 / POST 批量签发。
//
// 【鉴权全部交给 lib/auth/admin.requireAdmin】= 网页登录态（via='jwt'）+ uid ∈ env ADMIN_UIDS，
// 不过一律空体 404。本路由**不许自己再判一遍**白名单或 via：判两次就有两套口径，
// 而这条路后面接的是凭空造公道值。（那一份是 ws/admin-console 的 lib/admin/auth.ts 的临时替身，
// 合并轮归口，见该文件头。）
//
// 【为什么 GET 也走同一道闸】列表回的是**明文码**。一批还没被兑的码泄出去就是钱，
// 与签发同级敏感，没有「只读所以放松一点」这回事。
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/admin';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { issueRedeemCodes, listRedeemCodes } from '@/lib/billing/redeem';
import { getDb } from '@/lib/db/client';
import { toSql } from '@/lib/db/time';

/** 本路由每次都要按当前 env 与当前凭据判权，绝不能被静态化成一份「谁来都一样」的响应。 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const admin = requireAdmin(getDb(), req);
  if (!admin.ok) return admin.response;

  return NextResponse.json({ ok: true, codes: listRedeemCodes(getDb()) });
}

/** 一次最多签发多少张。挡的是把 count 手滑打成 100000 —— 那是一次性造出的无对价余额。 */
const MAX_BATCH = 500;

export async function POST(req: Request): Promise<NextResponse> {
  const admin = requireAdmin(getDb(), req);
  if (!admin.ok) return admin.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('BAD_REQUEST', '请求体不是合法 JSON');

  const count = Number(body.count);
  const gongdao = Number(body.gongdao);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    return badRequest('BAD_COUNT', `张数要填 1–${MAX_BATCH} 之间的整数`);
  }
  if (!Number.isInteger(gongdao) || gongdao < 1) {
    return badRequest('BAD_VALUE', '面值要填正整数');
  }

  // 到期时间入参是 ISO8601，落库前转 canonical 串（ADR-002：库里只存 canonical）。
  // 解不出来就报错，**不静默当作"永不过期"**——那会把一批本该限时的码变成永久码。
  const expiresRaw = stringField(body, 'expires_at').trim();
  let expiresAt: string | null = null;
  if (expiresRaw) {
    const d = new Date(expiresRaw);
    if (Number.isNaN(d.getTime())) return badRequest('BAD_EXPIRES_AT', '到期时间不是合法日期');
    expiresAt = toSql(d);
  }

  const note = stringField(body, 'note').trim() || null;
  const codes = issueRedeemCodes(getDb(), {
    count,
    gongdaoValue: gongdao,
    note,
    createdBy: admin.identity.uid,
    expiresAt,
  });

  return NextResponse.json({ ok: true, codes });
}
