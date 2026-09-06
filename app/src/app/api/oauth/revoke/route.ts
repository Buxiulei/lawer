// app/src/app/api/oauth/revoke/route.ts
// POST /api/oauth/revoke —— 客户端主动交还令牌（RFC 7009）。
//
// 【为什么无论如何都回 200】规范明确要求：认不出的令牌也算"已经不作用了"，回 200。
// 回 404 / 400 等于把这个口变成一台**令牌探测器**——试一串，看回什么，就知道它存不存在。
//
// 【交还一条 = 整条链一起停】客户端交还的通常是它手里的 refresh 或 access，而它的本意是
// "断开这次接入"。只作废被出示的那一条，另一半还能继续用满有效期，与用户的预期相反。
import { extractClientIp, createIpQuota } from '@/lib/auth/ip-quota';
import { hashSecret, oauthError, oauthJson, readOauthForm } from '@/lib/auth/oauth';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/oauth';
import { toSql } from '@/lib/db/time';

/** 与换令牌同一个量级的桶（各记各的）：这个口同样不鉴权，且同样可被拿来当探测器刷。 */
const revokeQuota = createIpQuota(120, 60 * 60 * 1000);

export async function POST(req: Request) {
  if (!revokeQuota.checkAndRecord(extractClientIp(req.headers))) {
    return oauthError(
      'temporarily_unavailable',
      '这个网络地址最近调用吊销的次数已达上限（每小时 120 次）。' +
        '交还令牌是断开接入时才做一次的事，撞上这个数说明有人在拿它试串。' +
        '等一小时后再试；若确实是客户端在重试，请先看它为什么没收下 200。',
      429,
    );
  }

  const form = await readOauthForm(req);
  const token = form?.token ?? '';
  if (token) {
    const row = store.findTokenByHash(getDb(), hashSecret(token));
    // 认不出就什么也不做，但仍然回 200——见文件抬头
    if (row) store.revokeChain(getDb(), row.code_id, toSql(new Date()));
  }
  return oauthJson({});
}
