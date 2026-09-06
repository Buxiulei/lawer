// app/src/lib/auth/identity.ts
// Bearer 双态解析：一个 Authorization 头，两种凭据。
//   via='jwt'      网页用户的登录态（/auth/sms/verify 签发，7 天过期）
//   via='api_key'  用户自己的 agent 直连用的长期凭据（MCP / REST），
//                  以及 OAuth 授权换来的 access token——两者在库里都落到同一条 api_keys 上，
//                  权限与吊销因此天然等价（见 resolveOauthAccessToken）
// 路由拿到的永远是同一个 {uid, via, scopes}，不必关心对方是浏览器还是 agent。
//
// 解析顺序：先试 JWT（纯 HMAC，不碰库；不是三段式立刻返回 null），再试 api key（查库）。
// 不靠"长得像不像"来分流——凭据的字母表将来可能变，但"验得过才算数"永远成立。
import type { Database } from 'better-sqlite3';

import * as store from '@/lib/db/api-keys';
import * as oauthStore from '@/lib/db/oauth';
import { toSql } from '@/lib/db/time';
import { hashApiKey, parseScopes, verifyApiKey, type Scope } from './api-key';
import { hashSecret } from './oauth';
import { verifyToken } from './jwt';

export interface Identity {
  uid: number;
  via: 'jwt' | 'api_key';
  /** 网页登录态视为全权；api key 只有它被授予的那些 */
  scopes: readonly Scope[];
  /** via='api_key' 时为该 key 的 id，便于审计与吊销 */
  keyId?: number;
}

const JWT_SCOPES: readonly Scope[] = ['case:read', 'case:write'];

/** 从 Authorization: Bearer 或 X-API-Key 取出凭据明文（照抄 NBDpsy 的双取法） */
export function extractBearer(headers: Headers): string | null {
  const auth = headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) {
    const token = match[1].trim();
    if (token) return token;
  }
  const apiKeyHeader = headers.get('x-api-key')?.trim();
  return apiKeyHeader ? apiKeyHeader : null;
}

/**
 * 解析请求身份。任何一种凭据验不过都返回 null——调用方一律回 401，
 * 不区分"没带"和"带错了"，免得把"这把 key 存在但停用了"这类信息漏给攻击者。
 * @param now 注入用于测试，判 JWT 与 OAuth access token 是否过期；last_used_at 由 SQLite 自己取时间（ADR-002）
 */
export function resolveIdentity(
  db: Database,
  headers: Headers,
  now: Date = new Date(),
): Identity | null {
  const token = extractBearer(headers);
  if (!token) return null;

  const payload = verifyToken(token, now);
  if (payload) {
    return { uid: payload.uid, via: 'jwt', scopes: JWT_SCOPES };
  }

  const row = store.findEnabledApiKeyByHash(db, hashApiKey(token));
  if (row && verifyApiKey(token, row.key_hash)) {
    store.touchApiKeyLastUsed(db, row.id);
    return {
      uid: row.user_id,
      via: 'api_key',
      scopes: parseScopes(row.scopes),
      keyId: row.id,
    };
  }

  return resolveOauthAccessToken(db, token, now);
}

/**
 * OAuth access token 解析。**结果与 api key 完全同形**（via='api_key' + 同一个 keyId），
 * 这不是偷懒：一次授权在库里就是一条 api_keys 行，令牌只是把它交到客户端手里的方式。
 * 若在这里另立一个 via='oauth'，每一处按 via 分支的代码都得同时想起还有第三种，
 * 而漏掉的那处会让两条等价的接入路径在权限上悄悄分叉。
 *
 * 三道闸缺一不可：令牌本身没吊销、没过期，以及**它挂靠的那条 api_keys 仍然启用**——
 * 最后一条正是设置页里那个「吊销」按钮生效的地方。
 */
function resolveOauthAccessToken(db: Database, token: string, now: Date): Identity | null {
  const tokenRow = oauthStore.findTokenByHash(db, hashSecret(token));
  if (!tokenRow || tokenRow.kind !== 'access') return null;
  if (tokenRow.revoked_at) return null;
  if (tokenRow.expires_at <= toSql(now)) return null;

  const key = store.findApiKeyById(db, tokenRow.key_id);
  if (!key || key.enabled !== 1) return null;

  store.touchApiKeyLastUsed(db, key.id);
  return {
    uid: key.user_id,
    via: 'api_key',
    scopes: parseScopes(key.scopes),
    keyId: key.id,
  };
}

export function hasScope(identity: Identity, scope: Scope): boolean {
  return identity.scopes.includes(scope);
}
