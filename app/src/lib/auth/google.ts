// app/src/lib/auth/google.ts
// Google 一键登录（OAuth 2.0 授权码流）。**默认关闭**，见 isGoogleOauthEnabled。
//
// 流程：
//   GET /api/v1/auth/google/start     → 302 到 Google 授权页，同时下发 state cookie
//   GET /api/v1/auth/google/callback  → 校验 state → 拿 code 换 token → 解 id_token
//                                     → 归并/建号 → 302 回站内并把 JWT 交给前端
//
// ── 与 NBDpsy 那版（后端服务/管理后端/src/handlers/client_api/auth_google.rs）的关系 ──
// 归并顺序（google_sub → 邮箱 → 建号）、email_verified 必须为 true、日志不落完整邮箱，
// 这几条照搬。**流程不同**：NBDpsy 走 GIS ID Token 流（浏览器把 credential 交给后端），
// 本站按派单走授权码流。这个差别决定了下面一件要紧事——见 parseIdTokenFromTokenEndpoint
// 顶上那段「为什么这里不验签」。
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { gongdaoGrant } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';
import { signToken } from './jwt';
import { provisionOnRegistered, type AuthFailure } from './otp';

// ========== 常量 ==========

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** 授权码换 token 的默认端点，可被 GOOGLE_TOKEN_ENDPOINT 覆盖（见 readGoogleConfig） */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** id_token 的两种历史 iss 取值，都要收（照 NBDpsy GOOGLE_ISSUERS） */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * 只要 openid + email。**不要 profile**：users 表没有存昵称/头像的列，
 * 要来既用不上，又平白多问用户一份授权——最小权限不是姿态，是少拿一份不该拿的数据。
 */
const OAUTH_SCOPE = 'openid email';

/** 回调路径，同时也是要去 Google 控制台登记的 redirect URI 的后半段 */
export const GOOGLE_CALLBACK_PATH = '/api/v1/auth/google/callback';
/** 回调完成后把用户送回哪一页（token / 错误经 URL fragment 交给前端） */
const LANDING_PATH = '/login';

/** state cookie 名 */
export const GOOGLE_STATE_COOKIE = 'lawer_google_state';
/** state 有效期：够慢的人在 Google 那边选完账号，又短到过期的 state 没有回收价值 */
const STATE_TTL_SECONDS = 600;
/** 换 token 的超时；Google 端点不通时别把请求挂死在那儿 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 8000;

// ========== 功能开关 ==========

/**
 * 总开关，**默认关**（暗启）。取 '1' 或 'true'（忽略大小写与首尾空白），其余一律视为关闭。
 *
 * 认不出的值按「关」处理而不是按「开」：这个开关关着的时候整条路由 404，
 * 打错一个字母的代价只是「功能没开」；反过来把 GOOGLE_OAUTH_ENABLED=flase 认成开，
 * 就是在凭据还没配好的时候把一条登录入口暴露出去。
 */
export function isGoogleOauthEnabled(): boolean {
  const raw = (process.env.GOOGLE_OAUTH_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

// ========== 配置 ==========

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** 站点对外基址，无结尾斜杠 */
  publicUrl: string;
  /** 换 token 的端点 */
  tokenEndpoint: string;
  /** 完整 redirect URI，必须与 Google 控制台登记的逐字一致 */
  redirectUri: string;
}

function fail(status: number, errorCode: string, message: string): AuthFailure {
  return { ok: false, status, errorCode, message };
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * 读齐配置。缺任何一项都返回 503 + 三段式说明，**不猜、不兜底**。
 *
 * 【LAWER_PUBLIC_URL 为什么在这里是必填的】别处（lib/mcp/setup.ts）没配就退回请求自身的
 * origin，那在这里是个漏洞：redirect_uri 若跟着 Host 头走，攻击者改一个 Host 就能把
 * 授权码送到自己的域名上。**redirect_uri 只能来自服务端自己的配置，绝不能来自请求。**
 * 所以宁可整条路由报「没配」，也不退回 origin。
 */
export function readGoogleConfig(): { ok: true; config: GoogleConfig } | AuthFailure {
  const clientId = env('GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET');
  const publicUrl = env('LAWER_PUBLIC_URL').replace(/\/+$/, '');

  const missing = [
    clientId ? '' : 'GOOGLE_CLIENT_ID',
    clientSecret ? '' : 'GOOGLE_CLIENT_SECRET',
    publicUrl ? '' : 'LAWER_PUBLIC_URL',
  ].filter(Boolean);

  if (missing.length > 0) {
    return fail(
      503,
      'GOOGLE_OAUTH_MISCONFIGURED',
      `Google 登录已打开开关但没配齐凭据，缺：${missing.join('、')}。` +
        'GOOGLE_OAUTH_ENABLED 打开时这三项都必须有值（redirect_uri 由 LAWER_PUBLIC_URL 拼出来，' +
        '不能跟着请求的 Host 走，否则授权码会被引到别人的域名上）。' +
        `请在部署的 env 里补上这几项，并确认 Google 控制台已登记 redirect URI：` +
        `<LAWER_PUBLIC_URL>${GOOGLE_CALLBACK_PATH}；补完重启应用即生效。`,
    );
  }

  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      publicUrl,
      tokenEndpoint: env('GOOGLE_TOKEN_ENDPOINT') || GOOGLE_TOKEN_URL,
      redirectUri: `${publicUrl}${GOOGLE_CALLBACK_PATH}`,
    },
  };
}

// ========== state（防 CSRF）==========

/**
 * 造一个 state。128 位 CSPRNG——这是防的是「攻击者把自己的授权码塞进受害者浏览器」
 * （OAuth 2.0 Security BCP §4.7 的登录 CSRF），可猜到就等于没防。
 */
export function createOauthState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * 比对两个 state。定长比较，不早退——state 不是密钥，但比较用等时函数是零成本的习惯，
 * 没有理由在这里留一条计时侧信道。
 */
export function statesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 从 Cookie 请求头里取一个 cookie 的值，取不到返回空串。
 *
 * **同名多条时取第一条**（return，不是继续覆盖）：RFC 6265 §5.4 要求浏览器把
 * Path 更长的排在前面，我们这条是 `Path=/api/v1/auth/google`，会排在被植入的
 * `Path=/` 同名 cookie 之前。改成取最后一条，等于把优先权让给攻击者种下的那条。
 */
export function readCookie(cookieHeader: string | null, name: string): string {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/**
 * state cookie 的 Set-Cookie 串。
 *
 *  - HttpOnly：state 只有服务端要读，脚本读不到就少一条被 XSS 顺走的路。
 *  - SameSite=Lax（**不能用 Strict**）：从 Google 跳回来是跨站的顶层导航，
 *    Strict 会让这个 cookie 不被带上，于是每一次正常登录都判成 state 不匹配。
 *  - Path 收到 Google 这条路由下：别的接口不需要看见它。
 *  - Secure 只在 https 基址下加：本地开发是 http，加了浏览器直接不存，登录必失败。
 */
export function stateCookieHeader(config: GoogleConfig, value: string): string {
  const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
  const maxAge = value ? STATE_TTL_SECONDS : 0;
  return (
    `${GOOGLE_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/v1/auth/google; ` +
    `Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
  );
}

/** 用完即焚：回调不论成败都把 state cookie 清掉，一个 state 只能换一次登录 */
export function clearStateCookieHeader(config: GoogleConfig): string {
  return stateCookieHeader(config, '');
}

// ========== 授权 URL ==========

export function buildAuthorizeUrl(config: GoogleConfig, state: string): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

// ========== 落地 URL（把结果交给前端）==========

/**
 * 结果走 URL **fragment** 而不是 query。
 * fragment 不会发给服务端，于是不进 Caddy 访问日志、不进 Referer 头——
 * 一个 7 天有效的 JWT 落进反代日志，等于把登录态明文存了一份在磁盘上。
 */
export function successLandingUrl(config: GoogleConfig, token: string, isNew: boolean): string {
  const frag = new URLSearchParams({ google_token: token, is_new: isNew ? '1' : '0' });
  return `${config.publicUrl}${LANDING_PATH}#${frag.toString()}`;
}

/**
 * 失败也送回登录页，三段式原文一起带过去，前端直接显示，不用自己再维护一份文案表。
 *
 * 【编码】两个值都经 URLSearchParams 序列化后才拼进 fragment，故一律 percent-encode：
 * `<` → `%3C`、`&` → `%26`、CR/LF → `%0D%0A`。少了这一步，一个带 `&` 或换行的文案就能
 * 在 fragment 里多造出一个键（比如伪造 `google_token=`），换行还能撑破 Location 响应头。
 * 别改成手工拼串。
 *
 * 【⚠️ 给前端接线单的死规矩，不许打折】`google_message` **只能按纯文本渲染**——
 * React 的 `{msg}`、DOM 的 `textContent`；**一律不得** `innerHTML` /
 * `dangerouslySetInnerHTML` / `v-html`。上面那道 percent-encode 只保证「URL 本身不被撑破」，
 * 保证不了「取出来之后被谁当 HTML 塞进 DOM」——按 HTML 渲染即是 XSS，
 * 而本站 localStorage 里正躺着一枚 7 天有效的 JWT。
 * 判据见 __tests__/google.test.ts「落地 URL」一节的编码两条。
 */
export function failureLandingUrl(config: GoogleConfig, failure: AuthFailure): string {
  const frag = new URLSearchParams({
    google_error: failure.errorCode,
    google_message: failure.message,
  });
  return `${config.publicUrl}${LANDING_PATH}#${frag.toString()}`;
}

// ========== id_token 解析 ==========

export interface GoogleIdentity {
  /** Google 账号的稳定标识 */
  sub: string;
  /** 已归一化（去空白 + 小写）的邮箱 */
  email: string;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

const INVALID_TOKEN_MESSAGE =
  'Google 返回的登录凭证没通过校验，这次登录没有完成。' +
  '常见原因是站点在 Google 控制台的配置与服务端不一致（client_id 对不上），或凭证已经过期。' +
  '请重新点一次「使用 Google 登录」；仍然失败的话改用手机号或邮箱验证码登录，两条路进的是同一个账号。';

/**
 * 解出 id_token 里归并要用的 claim，并逐条校验 iss / aud / exp / email_verified。
 *
 * ── ⚠️ 为什么这里不验 RS256 签名（读到这儿的人多半正想加上，先看完再决定）──
 * 本函数**只允许喂给它「刚从 Google token 端点取回来的」id_token**（函数名就是这个约束）。
 * 那份 token 是我们自己用 client_secret、经 TLS、直连 Google 拿回来的，
 * 信道本身已经完成了「这确实是 Google 说的话」的认证——Google 官方文档亦明示此时可以
 * 跳过验签。NBDpsy 那版**必须**验签，因为它的 credential 是**浏览器交上来的**，
 * 信道不可信，除了签名没有第二样东西能证明来源。两边的差别在这里，不在谨慎程度上。
 *
 * 所以：**若将来有人要把某个来自浏览器/前端的 token 交给本函数，必须先补 JWKS 验签**
 * （照 NBDpsy auth_google.rs 的缓存 + 单飞 + 未知 kid 限频那一套），不能直接复用。
 * 下面这几条 claim 校验是纵深防御，不是来源认证，替代不了签名。
 */
export function parseIdTokenFromTokenEndpoint(
  idToken: string,
  clientId: string,
  now: Date,
): { ok: true; identity: GoogleIdentity } | AuthFailure {
  const invalid = () => fail(401, 'GOOGLE_TOKEN_INVALID', INVALID_TOKEN_MESSAGE);

  const parts = (idToken ?? '').split('.');
  if (parts.length !== 3) return invalid();

  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as IdTokenClaims;
  } catch {
    return invalid();
  }
  if (!claims || typeof claims !== 'object') return invalid();

  // iss：必须是 Google 那两个取值之一
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) return invalid();

  // aud：必须**恰好等于**本站 client_id。只认字符串——JWT 规范允许 aud 是数组，
  // 但 Google 发的是字符串，收窄到字符串是往严的方向收，不是漏判。
  if (typeof claims.aud !== 'string' || claims.aud !== clientId) return invalid();

  // exp：必须是数字且还没过期。缺 exp 直接判废，不按"没写就是不过期"处理。
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return invalid();
  if (claims.exp <= Math.floor(now.getTime() / 1000)) return invalid();

  if (typeof claims.sub !== 'string' || claims.sub.trim() === '') return invalid();

  // email_verified 只认布尔 true。字符串 "true"、1、undefined 一律不算——
  // 这一条是整条链路上唯一能拦住「拿别人的邮箱开一个别人的账号」的判据，
  // 松一格就等于把归并键交给了一个没人验过的字符串。
  if (claims.email_verified !== true) {
    return fail(
      403,
      'GOOGLE_EMAIL_UNVERIFIED',
      '这个 Google 账号的邮箱还没有在 Google 那边完成验证，所以不能用它登录本站。' +
        '本站按邮箱把 Google 账号和已有档案对上号，未经验证的邮箱可能并不属于登录的人，' +
        '认了它就等于让人凭一个没人证实过的地址进别人的档案。' +
        '请先到 Google 账号设置里把邮箱验证完成，或者直接用手机号 / 邮箱验证码登录。',
    );
  }

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (email === '') return invalid();

  return { ok: true, identity: { sub: claims.sub.trim(), email } };
}

// ========== 换 token ==========

const EXCHANGE_FAILED_MESSAGE =
  '服务端在向 Google 兑换登录凭证时没有成功，这次登录没有完成。' +
  '这一步是本站服务器直接连 Google 的，用户网络正常也可能因为服务器侧连不上或授权码已被用过而失败。' +
  '请回登录页重试一次；连续失败请改用手机号或邮箱验证码登录，并把这个时间点告诉运维查服务端出网。';

async function exchangeCodeForIdToken(
  config: GoogleConfig,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; idToken: string } | AuthFailure> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });

  let resp: Response;
  try {
    resp = await fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    // 只记类型不记内容：body 里有 client_secret，异常对象可能把它带出来
    console.error('[auth/google] 换 token 请求失败', { name: (err as Error)?.name });
    return fail(502, 'GOOGLE_EXCHANGE_FAILED', EXCHANGE_FAILED_MESSAGE);
  }

  if (!resp.ok) {
    console.error('[auth/google] 换 token 被拒', { status: resp.status });
    return fail(502, 'GOOGLE_EXCHANGE_FAILED', EXCHANGE_FAILED_MESSAGE);
  }

  let payload: { id_token?: unknown };
  try {
    payload = (await resp.json()) as { id_token?: unknown };
  } catch {
    return fail(502, 'GOOGLE_EXCHANGE_FAILED', EXCHANGE_FAILED_MESSAGE);
  }

  const idToken = payload?.id_token;
  if (typeof idToken !== 'string' || idToken.trim() === '') {
    return fail(502, 'GOOGLE_EXCHANGE_FAILED', EXCHANGE_FAILED_MESSAGE);
  }
  return { ok: true, idToken };
}

// ========== 归并 / 建号 ==========

export interface ResolvedGoogleUser {
  userId: number;
  /** true = 这次新建的账号 */
  isNew: boolean;
}

/** 日志用的邮箱脱敏（照 NBDpsy mask_email）：留首字母与域名，够定位，不泄露 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

const CONFLICT_MESSAGE =
  '这个邮箱在本站已经有账号了，而那个账号绑的是另一个 Google 账号，所以这次没能登进去。' +
  '本站一个邮箱只对应一个档案，允许第二个 Google 账号绑上来就等于给同一份案件档案开了两把钥匙。' +
  '请改用当初绑定的那个 Google 账号登录；或者用这个邮箱走邮箱验证码登录，进的是同一个档案。';

/**
 * 归并顺序（照 NBDpsy auth_google.rs §4.3）：google_sub → 邮箱 → 建号。
 *
 * ① sub 命中：同一个 Google 账号回来了，直接登录。
 * ② 邮箱命中：这个人先前用手机号或邮箱验证码注册过，把 Google 绑到那个档案上，
 *    **不新建账号**——新建就意味着他上次存进来的案件材料这次全看不见。
 * ③ 都没命中：建号。
 */
export function resolveGoogleUser(
  db: Database,
  identity: GoogleIdentity,
  now: Date,
): { ok: true; user: ResolvedGoogleUser } | AuthFailure {
  const verifiedAt = toSql(now);

  // ① google_sub
  const bySub = store.findUserByGoogleSub(db, identity.sub);
  if (bySub) return { ok: true, user: { userId: bySub.id, isNew: false } };

  // ② 邮箱
  const byEmail = store.findUserByEmail(db, identity.email);
  if (byEmail) {
    if (byEmail.google_sub && byEmail.google_sub !== identity.sub) {
      console.warn('[auth/google] 邮箱已绑其他 Google 账号', { email: maskEmail(identity.email) });
      return fail(409, 'GOOGLE_ACCOUNT_CONFLICT', CONFLICT_MESSAGE);
    }
    const bound = store.bindGoogleSub(db, { userId: byEmail.id, googleSub: identity.sub });
    if (!bound) {
      // 守卫没命中 = 这一瞬间有人抢先绑上了。回查判定绑的是不是同一个 Google 账号；
      // **不能默认是自己绑的**——猜错就是把 A 的 Google 记到 B 的档案上。
      const raced = store.findUserByGoogleSub(db, identity.sub);
      if (raced) return { ok: true, user: { userId: raced.id, isNew: false } };
      return fail(409, 'GOOGLE_ACCOUNT_CONFLICT', CONFLICT_MESSAGE);
    }
    return { ok: true, user: { userId: byEmail.id, isNew: false } };
  }

  // ③ 建号。
  // 【建号与注册赠送必须同生同死】与手机线（otp.ts verifyPhoneCode）同一条约束：
  // 没有赠送的新账号余额为 0，第一个计费动作就被 gongdaoGate 拦死，
  // 而这种账号看起来一切正常——用户会以为是产品坏了，不会重试。
  // 所以包在同一个事务里，要么两件都成，要么一件都不成。
  const createAccount = db.transaction(() => {
    const id = store.insertGoogleUser(db, {
      email: identity.email,
      googleSub: identity.sub,
      verifiedAt,
    });
    gongdaoGrant(id, REGISTER_GRANT_GONGDAO, GONGDAO_LEDGER_TYPE.register, `reg-${id}`, null, db);
    return id;
  });
  return { ok: true, user: { userId: createAccount(), isNew: true } };
}

// ========== 回调总装 ==========

export interface GoogleCallbackInput {
  /** 回调 URL 上的 code（Google 给的授权码） */
  code: string;
  /** 回调 URL 上的 state */
  state: string;
  /** 从 Cookie 头里读出来的 state */
  cookieState: string;
  /** 回调 URL 上的 error（用户在 Google 页面点了取消时有值） */
  error?: string;
}

export interface GoogleDeps {
  /** 单测注入，替掉真的 POST；生产不传，走全局 fetch */
  fetchImpl?: typeof fetch;
  now?: Date;
}

export type GoogleCallbackResult =
  | { ok: true; token: string; userId: number; isNew: boolean }
  | AuthFailure;

const STATE_MISMATCH_MESSAGE =
  '这次 Google 登录的来路没能验证通过（防跨站伪造的一次性凭据对不上），已经中止。' +
  '通常是登录页开着超过 10 分钟才点完、中途换了浏览器或标签页、或者浏览器拦了本站 cookie；' +
  '也可能是有人把一条伪造的登录链接发给了你。' +
  '请回到本站登录页重新点一次「使用 Google 登录」，不要从别处收到的链接进入。';

const USER_CANCELLED_MESSAGE =
  '你在 Google 那边取消了授权，所以这次没有登录。' +
  '本站需要读取你的 Google 邮箱地址来对上（或建立）你的档案，不授权就没有可以对号的依据。' +
  '想继续的话回登录页再点一次；不想用 Google 也可以直接用手机号或邮箱验证码登录。';

/**
 * Google 回调 `error` 参数的形状白名单。RFC 6749 §4.1.2.1 的错误码是小写字母加下划线
 * （access_denied / invalid_request / admin_policy_enforced …），形状之外的一律不带进文案。
 *
 * 这是 state 闸门之后的第二道：过了 state 也不代表这个人不是被一条钓鱼链接引着
 * 自己走了一遍授权流程，把他给的原文回显到本站页面上没有任何好处。
 */
const OAUTH_ERROR_CODE_RE = /^[a-z_]{1,64}$/;

/**
 * 回调全流程：校 state → 认 error → 校 code → 换 token → 解 id_token → 归并/建号 → 签发 JWT。
 *
 * **state 校验放在最前，先于 error 分支**，也先于任何一次外呼与任何一次落库：
 *
 *  · 对外呼/落库：state 不过就说明这次回调的来路不明，此时去 Google 换 token
 *    等于替一条伪造链接干活。
 *  · **对 error 分支**：RFC 6749 §4.1.2.1 规定 Google 连报错回调也必须带回 state，
 *    所以这道闸放在 error 之前不会误伤任何一次真实的取消/失败；放在之后则是一条
 *    **免鉴权的反射面**——`GET /callback?error=<任意文本>` 不带 cookie、不带 state、
 *    不带 code 就能命中 302，把攻击者自造的文本（「账号冻结，加客服微信解冻」那类）
 *    挂到本站真实域名的 /login 上，长度还不设上限。
 *
 * **这三条的先后次序本身就是判据**，不是可以顺手调的行序；见 __tests__/google.test.ts
 * 「error 分支必须在 state 闸门之内」。
 */
export async function completeGoogleCallback(
  db: Database,
  config: GoogleConfig,
  input: GoogleCallbackInput,
  deps: GoogleDeps = {},
): Promise<GoogleCallbackResult> {
  const now = deps.now ?? new Date();

  if (!statesMatch(input.state, input.cookieState)) {
    return fail(400, 'GOOGLE_STATE_MISMATCH', STATE_MISMATCH_MESSAGE);
  }

  if (input.error) {
    const code = input.error === 'access_denied' ? 'GOOGLE_CANCELLED' : 'GOOGLE_AUTH_FAILED';
    // 形状不合的原因代码只留一个占位符：文案是给运维定位用的，
    // 为此收下一段任意长度的攻击者文本不划算。
    const reason = OAUTH_ERROR_CODE_RE.test(input.error) ? input.error : '(形状不合，已略去)';
    const message =
      input.error === 'access_denied'
        ? USER_CANCELLED_MESSAGE
        : 'Google 没有完成这次授权，登录中止。' +
          `Google 给出的原因代码是 ${reason}，一般来自站点在 Google 控制台的配置问题，不是你的操作错误。` +
          '请改用手机号或邮箱验证码登录（进的是同一个账号），并把这个代码告诉运维。';
    return fail(400, code, message);
  }

  if (!input.code) {
    return fail(400, 'GOOGLE_EXCHANGE_FAILED', EXCHANGE_FAILED_MESSAGE);
  }

  const exchanged = await exchangeCodeForIdToken(config, input.code, deps.fetchImpl ?? fetch);
  if (!exchanged.ok) return exchanged;

  const parsed = parseIdTokenFromTokenEndpoint(exchanged.idToken, config.clientId, now);
  if (!parsed.ok) return parsed;

  const resolved = resolveGoogleUser(db, parsed.identity, now);
  if (!resolved.ok) return resolved;

  // 注册完成的判据只有一处住址（lib/auth/otp.ts provisionOnRegistered），这里只是调用它。
  // 建案失败不阻断登录——照邮箱线的既定处置。
  provisionOnRegistered(db, resolved.user.userId);

  return {
    ok: true,
    token: signToken(resolved.user.userId, now),
    userId: resolved.user.userId,
    isNew: resolved.user.isNew,
  };
}
