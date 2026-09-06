// app/src/lib/auth/oauth.ts
// OAuth 2.1 授权服务器的**判断与生成**部分（SQL 在 lib/db/oauth.ts，HTTP 在 app/api/oauth/*）。
//
// 【为什么要有这一层】有些客户端只认 OAuth，不接受在配置里手填 Bearer：想接进来就得
// 提供授权码流。我们发的仍然是不透明随机串（不是 JWT）——资源端本来就要查库判吊销，
// 自签 JWT 只是把同一次查库藏进签名校验后面，还多出一份密钥要管。
//
// 【与 api key 的关系】一次授权 = 一条 api_keys 行 + 挂在它上面的令牌链。
// 权限、吊销、审计全部沿用 api_keys 那一套，OAuth 只是**换一种把凭据交到客户端手里的方式**。
// 所以设置页吊销那一行，链上的令牌当场全失效——不必再有第二个吊销入口。
import crypto from 'node:crypto';

/** access token 有效期。短，是因为它随每次请求出现在网络上，且吊销靠的是它到期后必须回来换。 */
export const ACCESS_TTL_SECONDS = 60 * 60;

/** refresh token 有效期。30 天不用就得让用户重新授权一次。 */
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 授权码有效期。10 分钟：它只在浏览器回跳到客户端的那几秒里有用，长了纯属留给重放。 */
export const CODE_TTL_SECONDS = 10 * 60;

/** 只支持 S256。plain 等于没有 PKCE，OAuth 2.1 也已经把它移出公共客户端的可选项。 */
export const CODE_CHALLENGE_METHOD = 'S256';

/** 生成不透明随机串（32 字节熵，base64url）。code / access / refresh 共用这一处。 */
export function generateOpaque(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 生成 client_id。它是公开标识、不是凭据，但仍取足熵，免得被枚举出别人注册过什么。 */
export function generateClientId(): string {
  return `oc_${crypto.randomBytes(16).toString('hex')}`;
}

/** sha256 hex。库里存的就是它，明文不落库（与 api key 同口径）。 */
export function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

/**
 * PKCE S256 校验：BASE64URL(SHA256(code_verifier)) === code_challenge。
 * 常数时间比较，且长度不等直接判否（timingSafeEqual 长度不等会抛）。
 *
 * 【verifier 的长度下限不是装饰】RFC 7636 要求 43–128 字符。放行一个 3 字符的
 * verifier，challenge 就成了可爆破的量——而流程本身照常走通，没有任何一处会报错。
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (typeof codeVerifier !== 'string' || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const computed = Buffer.from(
    crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
  );
  const expected = Buffer.from(codeChallenge ?? '');
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

/**
 * 回调地址白名单校验：**精确匹配**注册时登记的某一项，不做前缀、不做同域放宽。
 *
 * 【为什么不能前缀匹配】注册了 `https://x.example.com/cb` 的客户端，前缀匹配下
 * `https://x.example.com/cb.attacker.com/` 与 `https://x.example.com/cb?next=//evil`
 * 都算命中，授权码就被送到别处去了——而用户看到的同意页一字不差。
 */
export function isRegisteredRedirectUri(registered: readonly string[], candidate: string): boolean {
  return registered.some((uri) => uri === candidate);
}

/**
 * 注册时能收下的回调地址：https，或 localhost / 127.0.0.1 上的 http（本机客户端没有证书）。
 * 其余一律拒——明文 http 回调等于把授权码放在网络上明发。
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // 片段（#...）在回调地址上没有意义，且会让精确匹配变成"看起来一样"的两串
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * OAuth 的错误形状是 RFC 6749 §5.2 定死的 `{ error, error_description }`，
 * 与站内 REST 的 `{ ok:false, error_code, message }` 不是一回事——客户端按前者解析，
 * 换成后者它只会显示一句「未知错误」。所以这里单独一份，不复用 lib/auth/http。
 *
 * error_description 走自述三段式：撞到的是什么 / 为什么会撞到 / 现在能怎么办。
 */
export function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      'content-type': 'application/json',
      // 令牌与错误都不该被任何一层缓存留下来
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

/** 成功响应同样禁缓存（RFC 6749 §5.1 明确要求）。 */
export function oauthJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

/**
 * 读 token / revoke 的请求体。OAuth 规定用 application/x-www-form-urlencoded；
 * 同时收下 JSON 是因为确有客户端这么发，而拒掉它换来的是一句无从排查的 400。
 * 两种都解不出就返回 null，调用方回 invalid_request。
 */
export async function readOauthForm(req: Request): Promise<Record<string, string> | null> {
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    const form = new URLSearchParams(await req.text());
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/**
 * 掩码：日志与回报里只出现这个，不出现明文。
 * 只留尾 4 位——留头会让"同一把凭据"在多份日志里可对齐，那正是我们不想要的。
 */
export function maskSecret(value: string): string {
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

/**
 * 对外路径表。metadata 里那几个 URL、同意页的跳转、文档里写给用户的地址，全从这里取——
 * 各处手打的形态是：改了 token 端点的路径，metadata 还指着旧的，而 metadata 自己
 * 长得完全正常，只有真去换令牌的客户端撞上 404。
 *
 * 两个 `.well-known` 路径由 next.config 的 rewrite 落到 /api/oauth/metadata/* 上：
 * 规范要求它们挂在**根域**下，而路由文件按目录组织；rewrite 是这两件事的接缝。
 */
export const OAUTH_PATHS = {
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  protectedResourceMetadata: '/.well-known/oauth-protected-resource',
  /** 用户看得见的那一页（登录 + 同意），不是 API */
  authorize: '/oauth/authorize',
  register: '/api/oauth/register',
  token: '/api/oauth/token',
  revoke: '/api/oauth/revoke',
} as const;

/** 受保护资源本体：MCP 端点。protected-resource metadata 指的就是它。 */
export const OAUTH_RESOURCE_PATH = '/api/mcp';

/** RFC 8414 授权服务器元数据。客户端读完这一份才知道往哪儿跳、往哪儿换令牌。 */
export function authorizationServerMetadata(base: string, scopes: readonly string[]) {
  return {
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${base}${OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // 只登记 S256。写上 plain 就等于允许客户端选它，而选了的那条链没有任何 PKCE 保护。
    code_challenge_methods_supported: [CODE_CHALLENGE_METHOD],
    // public client：客户端跑在别人的服务器上，我们无从给它保管 secret
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...scopes],
    service_documentation: `${base}/skill/SKILL.md`,
  };
}

/** RFC 9728 受保护资源元数据：这个资源由哪台授权服务器发令牌。 */
export function protectedResourceMetadata(base: string, scopes: readonly string[]) {
  return {
    resource: `${base}${OAUTH_RESOURCE_PATH}`,
    authorization_servers: [base],
    scopes_supported: [...scopes],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/api/manifest`,
  };
}
