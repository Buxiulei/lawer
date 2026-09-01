// app/src/app/api/v1/admin/codes/route.ts
// 管理后台的兑换码面：GET 列表 / POST 批量签发。
// 鉴权 = 登录态 uid ∈ env ADMIN_UIDS（见 lib/auth/admin.ts）。
import { NextResponse } from 'next/server';

import { isAdminUid } from '@/lib/auth/admin';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { resolveIdentity } from '@/lib/auth/identity';
import { issueRedeemCodes, listRedeemCodes } from '@/lib/billing/redeem';
import { getDb } from '@/lib/db/client';
import { toSql } from '@/lib/db/time';

/** 本路由每次都要按当前 env 与当前凭据判权，绝不能被静态化成一份「谁来都一样」的响应。 */
export const dynamic = 'force-dynamic';

/**
 * 不是管理员就当**这条路由不存在**：空体 404，不是 403。
 *
 * 403 等于承认「这里有个后台，只是你进不去」——那正是值得花时间撞的东西。
 * 三种人拿到的东西必须一模一样：没登录的、登录了但不在白名单的、随便试地址的。
 * 所以不区分 401/403，也不回任何 error_code（error_code 本身就是「路由存在」的证据）。
 */
function notThere(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

/** 过了就是管理员 uid，没过就是那个 404。 */
function requireAdmin(req: Request): { ok: true; uid: number } | { ok: false; response: NextResponse } {
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity || !isAdminUid(identity.uid)) return { ok: false, response: notThere() };
  return { ok: true, uid: identity.uid };
}

export async function GET(req: Request): Promise<NextResponse> {
  const admin = requireAdmin(req);
  if (!admin.ok) return admin.response;

  return NextResponse.json({ ok: true, codes: listRedeemCodes(getDb()) });
}

/** 一次最多签发多少张。挡的是把 count 手滑打成 100000 —— 那是一次性造出的无对价余额。 */
const MAX_BATCH = 500;

export async function POST(req: Request): Promise<NextResponse> {
  const admin = requireAdmin(req);
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
    createdBy: admin.uid,
    expiresAt,
  });

  return NextResponse.json({ ok: true, codes });
}
