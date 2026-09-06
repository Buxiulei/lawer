// app/src/app/api/oauth/token/route.ts
// POST /api/oauth/token —— 授权码换令牌 + refresh 换令牌。
//
// 本口不鉴权（public client 没有 client_secret）：凭据是 code_verifier（PKCE）或 refresh_token
// 本身。所以每一条拒绝都必须真的拒绝——这里是整条 OAuth 链上唯一把凭据换成权限的地方。
//
// 【两种"复用"都按泄漏处理】同一个 code 被换第二次、同一条 refresh 被用第二次，都说明
// 有第二方手里也有这份凭据。只作废被出示的那一条，等于把另一条留给对方继续用；
// 所以两种情况一律**吊销整条链**（revokeChain），用户下次调用会 401，需要重新授权。
import { parseScopes } from '@/lib/auth/api-key';
import { createIpQuota, extractClientIp } from '@/lib/auth/ip-quota';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  generateOpaque,
  hashSecret,
  oauthError,
  oauthJson,
  readOauthForm,
  verifyPkceS256,
} from '@/lib/auth/oauth';
import { findApiKeyById } from '@/lib/db/api-keys';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/oauth';
import { toSql } from '@/lib/db/time';
import type { Database } from 'better-sqlite3';

/**
 * 按 IP 的换令牌限流，自带一个桶（不与发码额度共享）。
 * 额度按"每小时 120 次"定：正常客户端 1 小时才换一次 access token，
 * 而爆破授权码的一方需要的次数远大于此。
 */
const tokenQuota = createIpQuota(120, 60 * 60 * 1000);

/** 一对新令牌 + 规范要求的响应字段。access 与 refresh 挂同一条链（code_id）。 */
function issuePair(
  db: Database,
  params: { codeId: number; keyId: number; userId: number; scopes: string[]; now: Date },
) {
  const access = generateOpaque();
  const refresh = generateOpaque();
  store.insertToken(db, {
    tokenHash: hashSecret(access),
    kind: 'access',
    codeId: params.codeId,
    keyId: params.keyId,
    userId: params.userId,
    expiresAt: toSql(new Date(params.now.getTime() + ACCESS_TTL_SECONDS * 1000)),
  });
  store.insertToken(db, {
    tokenHash: hashSecret(refresh),
    kind: 'refresh',
    codeId: params.codeId,
    keyId: params.keyId,
    userId: params.userId,
    expiresAt: toSql(new Date(params.now.getTime() + REFRESH_TTL_SECONDS * 1000)),
  });
  return oauthJson({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: params.scopes.join(' '),
  });
}

export async function POST(req: Request) {
  if (!tokenQuota.checkAndRecord(extractClientIp(req.headers))) {
    return oauthError(
      'temporarily_unavailable',
      '这个网络地址最近换取令牌的次数已达上限（每小时 120 次）。' +
        '正常客户端一小时才换一次，撞上这个数通常是客户端在循环重试。' +
        '先看看客户端那边是不是拿到了错误却一直重发，等一小时后再试。',
      429,
    );
  }

  const form = await readOauthForm(req);
  if (!form) {
    return oauthError(
      'invalid_request',
      '请求体读不出参数。令牌端点要求 application/x-www-form-urlencoded 编码的表单' +
        '（本服务也收 application/json）。请检查客户端的 Content-Type 与请求体后重发。',
    );
  }

  const db = getDb();
  const now = new Date();
  const nowSql = toSql(now);

  switch (form.grant_type) {
    case 'authorization_code':
      return exchangeCode(db, form, now, nowSql);
    case 'refresh_token':
      return exchangeRefresh(db, form, now, nowSql);
    default:
      return oauthError(
        'unsupported_grant_type',
        `不支持 grant_type=${form.grant_type || '(空)'}。` +
          '本服务只发两种：authorization_code（第一次换令牌）与 refresh_token（续期）。' +
          '客户端凭据流一类不适用——这里的每一次授权都必须由用户本人在网页上点过同意。',
      );
  }
}

function exchangeCode(
  db: Database,
  form: Record<string, string>,
  now: Date,
  nowSql: string,
): Response {
  const code = form.code ?? '';
  const row = code ? store.findCodeByHash(db, hashSecret(code)) : undefined;
  if (!row) {
    return oauthError(
      'invalid_grant',
      '这个授权码不存在。授权码是一次性的、10 分钟有效，且换过一次之后就不再存在。' +
        '常见原因是重复提交了同一次回调。请重新走一遍「添加连接器 → 登录 → 同意」。',
    );
  }

  // 二次使用：说明这份 code 至少落到过两方手里 → 连同它已经签出去的令牌一起作废
  if (row.consumed_at) {
    store.revokeChain(db, row.id, nowSql);
    return oauthError(
      'invalid_grant',
      '这个授权码已经用过了。授权码只能换一次令牌，第二次出现说明它可能已经泄漏，' +
        '所以本次不仅拒绝，还把它此前换出去的令牌一并吊销了（已接入的客户端会掉线）。' +
        '请重新走一遍授权，把新令牌配置回客户端。',
    );
  }

  if (row.expires_at <= nowSql) {
    return oauthError(
      'invalid_grant',
      '这个授权码已经过期（有效期 10 分钟）。它只在浏览器从同意页跳回客户端的那几秒里有用，' +
        '留久了纯属给重放留机会，所以期限压得很短。请重新发起一次授权。',
    );
  }

  if (form.client_id && form.client_id !== row.client_id) {
    return oauthError(
      'invalid_grant',
      '换令牌用的 client_id 与当初申请这个授权码的不是同一个。' +
        '授权码是发给某一个客户端的，换给别人等于把用户的档案交给他没同意过的一方。' +
        '请用发起授权时的那个 client_id 重试。',
    );
  }

  // redirect_uri 拿行上的比，不拿入参当真值——见 migrate.ts 里那段
  if ((form.redirect_uri ?? '') !== row.redirect_uri) {
    return oauthError(
      'invalid_grant',
      'redirect_uri 与发起授权时用的那个不一致。这一条比对是为了防止授权码被拿到' +
        '另一个回调地址上去兑换。请用发起授权时**完全相同**的地址重试（一个字符都不能差）。',
    );
  }

  if (!verifyPkceS256(form.code_verifier ?? '', row.code_challenge)) {
    return oauthError(
      'invalid_grant',
      'PKCE 校验没过：code_verifier 与发起授权时提交的 code_challenge 对不上' +
        '（或长度不在 43–128 字符之内）。这一步证明的是"来换令牌的和当初发起授权的是同一方"，' +
        '对不上就说明授权码可能是从别处拿到的。请让客户端用同一次流程里生成的 verifier 重试。',
    );
  }

  // 抢占式消费：并发的第二个请求会拿到 changes=0，绝不会两个都换出令牌
  if (!store.consumeCode(db, row.code_hash, nowSql)) {
    store.revokeChain(db, row.id, nowSql);
    return oauthError(
      'invalid_grant',
      '这个授权码在本次请求处理期间被另一个请求换走了。同一个码被两方同时兑换，' +
        '与"已经用过"是同一件事，所以此次同样拒绝并吊销了这条链上的令牌。' +
        '请重新走一遍授权。',
    );
  }

  const key = findApiKeyById(db, row.key_id);
  if (!key || key.enabled !== 1) {
    return oauthError(
      'invalid_grant',
      '这次授权对应的凭据已经在设置页被吊销了。吊销之后它换不出任何令牌——' +
        '这正是设置页那个「吊销」按钮该有的效果。要重新接入，请在客户端里重新授权一次。',
    );
  }

  return issuePair(db, {
    codeId: row.id,
    keyId: row.key_id,
    userId: row.user_id,
    scopes: parseScopes(key.scopes),
    now,
  });
}

function exchangeRefresh(
  db: Database,
  form: Record<string, string>,
  now: Date,
  nowSql: string,
): Response {
  const presented = form.refresh_token ?? '';
  const row = presented ? store.findTokenByHash(db, hashSecret(presented)) : undefined;
  if (!row || row.kind !== 'refresh') {
    return oauthError(
      'invalid_grant',
      'refresh_token 不存在（或拿的是 access token）。续期要用换令牌时一并发下来的' +
        ' refresh_token，且每次续期都会换一条新的、旧的当场作废。' +
        '若手上只剩失效的那条，请重新走一遍授权。',
    );
  }

  // 已作废的 refresh 被再次出示 = 要么是攻击者拿着截走的旧串，要么是客户端把旧串留着重发。
  // 两种都按泄漏处理：整条链吊销，逼一次重新授权。
  if (row.revoked_at) {
    store.revokeChain(db, row.code_id, nowSql);
    return oauthError(
      'invalid_grant',
      '这条 refresh_token 已经被用过或已被吊销。每次续期都会旋转出新的一条，' +
        '旧的再出现说明它可能已经泄漏，所以本次连同这条授权链上的全部令牌一起吊销了。' +
        '请在客户端里重新授权一次，并确认客户端保存的是最新那条 refresh_token。',
    );
  }

  if (row.expires_at <= nowSql) {
    return oauthError(
      'invalid_grant',
      '这条 refresh_token 已经过期（有效期 30 天）。超过 30 天没有用过的授权需要用户' +
        '重新确认一次，这样长期不用的接入不会一直挂着。请在客户端里重新授权。',
    );
  }

  const key = findApiKeyById(db, row.key_id);
  if (!key || key.enabled !== 1) {
    return oauthError(
      'invalid_grant',
      '这次授权对应的凭据已经在设置页被吊销了，续期同样不再受理。' +
        '这正是「吊销」该有的效果：一处吊销，令牌与续期一起停。' +
        '要重新接入，请在客户端里重新授权一次。',
    );
  }

  // 旋转：旧的 refresh 与旧的 access 一起作废，再发新的一对。
  // 旧 access 不作废的形态是：一条被截走的 refresh 换不出新令牌了，但截走方手里那条
  // access 还能再用满一小时。
  store.revokeChainKind(db, row.code_id, 'refresh', nowSql);
  store.revokeChainKind(db, row.code_id, 'access', nowSql);

  return issuePair(db, {
    codeId: row.code_id,
    keyId: row.key_id,
    userId: row.user_id,
    scopes: parseScopes(key.scopes),
    now,
  });
}
