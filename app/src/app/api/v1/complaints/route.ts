// app/src/app/api/v1/complaints/route.ts
// 投诉 / 举报 / 个人信息权利请求：POST 提交、GET 看自己提过的（协议第十二条第 1 款）。
//
// 【为什么走 requireWebSession，不走 requireIdentity】这条路上做的是**本人的法律行为**：
// 一条「请删除我的个人信息」要在 15 个工作日内办结、拒绝要说明理由。
// 让 api key 也能提的形态是：用户接进来的某个助手替他提了一条权利请求，
// 而 15 天的钟已经在走、答复会寄到那条记录里留的联系方式上——本人却不知道有这回事。
// 同 /api/v1/keys 与 /api/v1/realname 的口径（账号级动作只认网页登录态）。
//
// 【为什么受理编号由服务端生成】它是用户手上唯一的凭据。让前端传的形态是：
// 两个人可以拿着同一串来问，而我们答不出该翻哪一条（唯一性在 lib/complaints 保）。
import { requireWebSession } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { createComplaint, listMyComplaints } from '@/lib/complaints';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

/** 每次都按当前凭据判权，绝不能被静态化成一份「谁来都一样」的响应。 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('BAD_REQUEST', '请求体不是合法 JSON');

  const created = createComplaint(getDb(), {
    userId: guard.identity.uid,
    kind: stringField(body, 'kind'),
    body: stringField(body, 'body'),
    contact: stringField(body, 'contact'),
  });
  if (!created.ok) {
    return apiJson(
      { ok: false, error_code: created.errorCode, message: created.message },
      { status: created.status },
    );
  }

  // 201：这一次真的落了一行，而且用户手上多了一串编号。
  return apiJson({ ok: true, complaint: created }, { status: 201 });
}

export async function GET(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  return apiJson({ ok: true, complaints: listMyComplaints(getDb(), guard.identity.uid) });
}
