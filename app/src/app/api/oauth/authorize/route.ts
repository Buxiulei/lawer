// app/src/app/api/oauth/authorize/route.ts
// 授权请求的**服务端**两半：
//   GET  校验一次授权请求合不合法，回「谁在申请、要什么权限」给同意页显示（不签发任何东西）
//   POST 用户在同意页点了「同意」——**网页登录态**下签发一次性授权码，回一个可以跳的地址
//
// 用户看得见的那一页在 /oauth/authorize（app/oauth/authorize/page.tsx）：登录态存在
// localStorage 里，服务端渲染时读不到，所以「未登录先去登录」这件事只能由那一页做，
// 这里只负责"凭据说了算"的部分。
//
// 【GET 校完 POST 还要再校一遍】页面把参数原样回传，而页面是攻击者也能构造的东西。
// 只在 GET 校验的形态是：直接 POST 一份改过 redirect_uri 的参数，同意页那一屏根本没出现过。
import { ALL_SCOPES, type Scope } from '@/lib/auth/api-key';
import { requireWebSession } from '@/lib/auth/guard';
import {
  CODE_CHALLENGE_METHOD,
  CODE_TTL_SECONDS,
  generateOpaque,
  hashSecret,
  isRegisteredRedirectUri,
  oauthError,
  oauthJson,
} from '@/lib/auth/oauth';
import { insertOauthApiKey } from '@/lib/db/api-keys';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/oauth';
import { toSql } from '@/lib/db/time';

interface ValidRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  state: string | null;
}

/**
 * 一次授权请求的全部校验，GET 与 POST 共用这一份。
 *
 * 【为什么错误一律回给调用方，不回跳到 redirect_uri】规范允许在 redirect_uri 已确认合法后
 * 把错误带回客户端，但那要求先信任这个地址。这里的顺序是：地址没通过白名单之前，
 * 我们不往它上面送任何东西——包括错误。通过之后的参数错误（PKCE 缺失之类）也留在本域显示，
 * 用户至少能看见一句人话，而不是在客户端那边收到一个没有上下文的 error 参数。
 */
function validate(params: URLSearchParams | Record<string, string>):
  | { ok: true; value: ValidRequest }
  | { ok: false; response: Response } {
  const get = (name: string): string =>
    (params instanceof URLSearchParams ? params.get(name) : params[name])?.trim() ?? '';

  const responseType = get('response_type');
  if (responseType && responseType !== 'code') {
    return {
      ok: false,
      response: oauthError(
        'unsupported_response_type',
        `本服务只支持授权码流（response_type=code），收到的是 ${responseType}。` +
          '隐式流会把令牌直接放进浏览器地址栏，OAuth 2.1 已经把它去掉了。' +
          '请把客户端改成授权码 + PKCE 的配置再试。',
      ),
    };
  }

  const clientId = get('client_id');
  const client = clientId ? store.findClient(getDb(), clientId) : undefined;
  if (!client) {
    return {
      ok: false,
      response: oauthError(
        'invalid_client',
        `client_id ${clientId || '(空)'} 没有在本服务注册过。` +
          '客户端要先调 /api/oauth/register 拿到 client_id 才能发起授权；' +
          '若之前注册过，可能是换了环境（预发与生产各有各的注册表）。请重新注册一次。',
        401,
      ),
    };
  }

  const registered = JSON.parse(client.redirect_uris) as string[];
  const redirectUri = get('redirect_uri');
  if (!redirectUri || !isRegisteredRedirectUri(registered, redirectUri)) {
    return {
      ok: false,
      response: oauthError(
        'invalid_request',
        `redirect_uri ${redirectUri || '(空)'} 不在这个客户端注册时登记的回调地址里。` +
          '白名单是**精确匹配**的：多一个斜杠、多一个查询参数都算另一个地址，' +
          '这条规则是为了防止授权码被送到别处去。' +
          `请改用登记过的地址（共 ${registered.length} 个），或用新地址重新注册一个客户端。`,
      ),
    };
  }

  const method = get('code_challenge_method');
  const codeChallenge = get('code_challenge');
  if (method !== CODE_CHALLENGE_METHOD || !codeChallenge) {
    return {
      ok: false,
      response: oauthError(
        'invalid_request',
        `缺少 PKCE 参数，或 code_challenge_method 不是 ${CODE_CHALLENGE_METHOD}` +
          `（收到 method=${method || '(空)'}、challenge=${codeChallenge ? '有' : '(空)'}）。` +
          'PKCE 是公共客户端唯一能证明"来换令牌的和当初发起授权的是同一个人"的手段，' +
          '没有它，授权码被截走就能直接换出令牌，所以本服务不接受省略。' +
          '请在客户端打开 PKCE（S256）后重试。',
      ),
    };
  }

  const scopeParam = get('scope');
  let scopes: Scope[] = [...ALL_SCOPES];
  if (scopeParam) {
    const requested = scopeParam.split(/\s+/).filter(Boolean);
    const unknown = requested.filter((s) => !(ALL_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        response: oauthError(
          'invalid_scope',
          `请求了本服务没有的权限项：${unknown.join('、')}。` +
            `本服务一共只有两项：${ALL_SCOPES.join('、')}。` +
            '把 scope 改成这两项之内（或整个省略，省略即两项全给）后重试。',
        ),
      };
    }
    scopes = requested as Scope[];
  }

  const state = get('state');
  return {
    ok: true,
    value: {
      clientId,
      clientName: client.client_name,
      redirectUri,
      codeChallenge,
      scopes,
      // state 原样回传，一个字符都不改：它是客户端自己的防 CSRF 凭据，我们只是搬运
      state: state || null,
    },
  };
}

/** 同意页要显示的东西。**不签发任何凭据**，所以不鉴权——它说的是"谁在申请"，不是"给了谁"。 */
export async function GET(req: Request) {
  const checked = validate(new URL(req.url).searchParams);
  if (!checked.ok) return checked.response;
  return oauthJson({
    client_id: checked.value.clientId,
    client_name: checked.value.clientName,
    redirect_uri: checked.value.redirectUri,
    scopes: checked.value.scopes,
  });
}

/**
 * 用户点了「同意」。只认网页登录态（与 /api/v1/keys 同一条纪律）：
 * 拿一把 api key 或一个已有的 OAuth 令牌来这里换新授权，等于让一次泄漏自我续命。
 */
export async function POST(req: Request) {
  let body: Record<string, string>;
  try {
    const raw = (await req.json()) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad body');
    body = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return oauthError(
      'invalid_request',
      '同意请求的请求体不是一个 JSON 对象。这一条是同意页自己发的，' +
        '出现这个错误通常说明请求被中间层改写过。刷新授权页重来一次。',
    );
  }

  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) {
    return oauthError(
      'access_denied',
      '这一步需要「土八鼠」的网页登录态：授权是把你本人的档案交给客户端读写，' +
        '所以必须由你本人登录后确认，api key 或已有的授权令牌都不算。' +
        '请先在网页登录，再回到授权页点同意。',
      401,
    );
  }

  const checked = validate(body);
  if (!checked.ok) return checked.response;
  const { clientId, clientName, redirectUri, codeChallenge, scopes, state } = checked.value;

  const db = getDb();
  const now = new Date();

  // 一次授权 = 一条 api_keys 行。它就是设置页上用户看得见、能吊销的那一行；
  // key_hash 落一串永远不会被出示的随机值（见 insertOauthApiKey 抬头）。
  const keyId = insertOauthApiKey(db, {
    userId: guard.identity.uid,
    name: clientName,
    keyHash: hashSecret(generateOpaque()),
    scopesJson: JSON.stringify(scopes),
    clientName,
  });

  const code = generateOpaque();
  store.insertCode(db, {
    codeHash: hashSecret(code),
    clientId,
    userId: guard.identity.uid,
    keyId,
    redirectUri,
    codeChallenge,
    scopesJson: JSON.stringify(scopes),
    expiresAt: toSql(new Date(now.getTime() + CODE_TTL_SECONDS * 1000)),
  });

  // 回跳地址由服务端拼，页面只负责跳。让页面自己拼的形态是：redirect_uri 校验过了，
  // 而真正跳过去的是页面手里那一份没校验的串。
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state !== null) target.searchParams.set('state', state);

  return oauthJson({ redirect_to: target.toString() });
}
