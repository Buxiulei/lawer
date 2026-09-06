// app/src/app/api/oauth/register/route.ts
// POST /api/oauth/register —— 动态客户端注册（RFC 7591 的最小子集）。
//
// 【为什么必须动态】网页版连接器不会让用户去我们后台申请 client_id：它自己在添加连接器
// 那一刻拿着 metadata 里的 registration_endpoint 就地注册。没有这个口，整条 OAuth 路走不通。
//
// 【注册不是授权】这里发出去的 client_id 只是一个公开标识，不带任何权限——
// 拿着它什么也读不到，真正的闸在 /oauth/authorize 上（用户本人登录 + 明确同意）。
// 所以本口不鉴权；能被滥用的只有"往表里塞行"，那由按 IP 的限流挡。
import { createIpQuota, extractClientIp } from '@/lib/auth/ip-quota';
import {
  generateClientId,
  isAllowedRedirectUri,
  oauthError,
  oauthJson,
} from '@/lib/auth/oauth';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/oauth';

/**
 * 按 IP 的注册限流，自带一个桶（createIpQuota 每次新建 Map），**不与发码额度共享**——
 * 一个客户端反复注册不该把用户的验证码额度吃掉，反之亦然。
 *
 * 【进程内计数够不够】这一桶挡的是"往表里刷行"，不是鉴权；真正的安全边界是同意页与 PKCE。
 * 重启清零对这条的后果只是攻击者得等一次重启，代价与收益都很低。
 */
const registerQuota = createIpQuota(30, 60 * 60 * 1000);

/** 一次注册最多登记几个回调地址。不设上限等于让对方决定我们存多长。 */
const MAX_REDIRECT_URIS = 5;

export async function POST(req: Request) {
  if (!registerQuota.checkAndRecord(extractClientIp(req.headers))) {
    return oauthError(
      'temporarily_unavailable',
      '这个网络地址最近注册客户端的次数已达上限（每小时 30 次）。' +
        '出现这种情况通常是客户端在反复重试注册，而不是用户在反复添加连接器。' +
        '等一小时后再试；已经注册成功的 client_id 仍然有效，不必重新注册。',
      429,
    );
  }

  let body: Record<string, unknown> | null;
  try {
    body = (await req.json()) as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return oauthError(
      'invalid_client_metadata',
      '请求体不是一个 JSON 对象。动态注册要求 POST 一份 JSON（Content-Type: application/json），' +
        '里面至少要有 redirect_uris。请按 RFC 7591 的客户端元数据格式重发。',
    );
  }

  const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
  // 名字会原样显示在同意页上（"你正在把档案授权给 X"），所以截断到 64 字符，
  // 且**不编默认值**：报不出名字的客户端就照实显示"未具名的客户端"，不假装认出了它。
  const clientName = rawName ? rawName.slice(0, 64) : '未具名的客户端';

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError(
      'invalid_redirect_uri',
      `redirect_uris 必须是一个非空数组，最多 ${MAX_REDIRECT_URIS} 项。` +
        '授权码是经浏览器回跳送到这些地址上的，没有登记地址就没有地方可送。' +
        '请在注册请求里带上客户端的回调地址再重发。',
    );
  }
  const bad = uris.find((u) => !isAllowedRedirectUri(u));
  if (bad !== undefined) {
    return oauthError(
      'invalid_redirect_uri',
      `回调地址 ${typeof bad === 'string' ? bad : JSON.stringify(bad)} 不能登记。` +
        '只收 https 地址，或 localhost / 127.0.0.1 上的 http（本机客户端没有证书）；' +
        '带 # 片段的也不收，那会让日后的精确匹配变成两串"看起来一样"的地址。' +
        '把地址改成 https 后重新注册。',
    );
  }
  // 去重后再落库：同一地址登记两遍不会更安全，只会让日后核对白名单的人多读两行
  const redirectUris = [...new Set(uris as string[])];

  const clientId = generateClientId();
  store.insertClient(getDb(), {
    clientId,
    clientName,
    redirectUrisJson: JSON.stringify(redirectUris),
  });

  return oauthJson(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      // public client：没有 client_secret，换令牌时靠 PKCE 证明"是同一个发起方"
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
}
