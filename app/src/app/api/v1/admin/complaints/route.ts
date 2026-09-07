// app/src/app/api/v1/admin/complaints/route.ts
// 后台的受理台账面：**只读**。
//
// 【为什么没有 POST / PATCH】本票的后台列表页是只读的，受理与答复走站外（协议第十二条
// 留的那个邮箱）。补一条「标记已受理」的写接口而页面上没有入口的形态是：
// 一条谁都调得到、却没有任何审计与流程的状态写入摆在那里。
// 状态流转要做时，连同入口、审计（lib/admin/audit）与「谁改的」一起加。
//
// 【鉴权全部交给 lib/admin/auth.requireAdmin】= 网页登录态 + uid ∈ env ADMIN_UIDS，
// 不过一律空体 404。本路由不许自己再判一遍白名单——判两次就有两套口径。
//
// 【为什么这条也要那道闸】回包里有投诉人的联系方式（明文，服务端解密后下发）
// 与他写下的整段描述。「只读所以放松一点」在这里不成立。
import { requireAdmin } from '@/lib/admin/auth';
import { listAllComplaints } from '@/lib/complaints';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = requireAdmin(getDb(), req);
  if (!guard.ok) return guard.response;

  return apiJson({ ok: true, complaints: listAllComplaints(getDb()) });
}
