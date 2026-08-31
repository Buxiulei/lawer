// app/src/lib/auth/__tests__/google.test.ts
// Google 一键登录（授权码流）的判据。
//
// 【判据挑选原则】不写"函数被调用了""返回了对象"这种改完实现照样绿的断言。
// 每一条都钉一个**说错了就会出事**的事实：
//   · state 不过时**一次外呼都不该发生**（不是"最后返回了错误"）——否则伪造链接能驱使
//     我们的服务器替它去跟 Google 换 token；
//   · 新账号的判据是**能过计费门槛**，不是"账本里有行"（照 register-grant.test.ts 的教训：
//     产线上两个真实账号就是"建成了却用不了"）；
//   · 老账号绑定的判据是**旧案件还在同一个 uid 名下**，不是"返回了 isNew:false"。
import crypto from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getGongdao, gongdaoGate } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import { ensureDefaultCase } from '@/lib/cases';
import { hashLookup } from '@/lib/crypto';
import * as store from '@/lib/db/otp';
import {
  buildAuthorizeUrl,
  completeGoogleCallback,
  createOauthState,
  failureLandingUrl,
  isGoogleOauthEnabled,
  parseIdTokenFromTokenEndpoint,
  readCookie,
  readGoogleConfig,
  statesMatch,
  successLandingUrl,
  type GoogleConfig,
} from '../google';
import { sendEmailCode, sendPhoneCode, verifyEmailCode, verifyPhoneCode } from '../otp';
import { verifyToken } from '../jwt';
import { lastEmailCode, lastSmsCode, makeTestDb } from './helpers';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const PUBLIC_URL = 'https://law.example.com';
const NOW = new Date('2026-08-31T10:00:00.000Z');
const SUB = 'google-sub-1234567890';
const EMAIL = 'zhang@example.com';
const STATE = 'state-abcdefghijklmnop';

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.GOOGLE_OAUTH_ENABLED = '1';
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.LAWER_PUBLIC_URL = PUBLIC_URL;
  delete process.env.GOOGLE_TOKEN_ENDPOINT;
  vi.restoreAllMocks();
});

// ───────────────────────── 夹具 ─────────────────────────

function config(): GoogleConfig {
  const read = readGoogleConfig();
  if (!read.ok) throw new Error(`前置失败：配置读不出来 ${read.message}`);
  return read.config;
}

/** 造一个 id_token 形态的串。签名位是假的——本流程按设计不验签，见 google.ts 那段说明。 */
function idToken(overrides: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    ...overrides,
  };
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.not-a-real-signature`;
}

interface FetchLog {
  calls: { url: string; body: string }[];
}

/** 假的 token 端点。**记下每一次调用**，好让"不该外呼"这类判据有东西可断言。 */
function fakeFetch(log: FetchLog, token: string = idToken()): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    log.calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ id_token: token }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

type Db = ReturnType<typeof makeTestDb>;

/** 走一遍回调，默认 state 与 cookie 一致（"正常登录"这条路） */
async function callback(
  db: Db,
  opts: { state?: string; cookieState?: string; code?: string; error?: string; token?: string } = {},
  log: FetchLog = { calls: [] },
) {
  return completeGoogleCallback(
    db,
    config(),
    {
      code: opts.code ?? 'auth-code-xyz',
      state: opts.state ?? STATE,
      cookieState: opts.cookieState ?? STATE,
      error: opts.error,
    },
    { fetchImpl: fakeFetch(log, opts.token ?? idToken()), now: NOW },
  );
}

function userCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
}

// ───────────────────────── 开关 ─────────────────────────

describe('功能开关（默认关）', () => {
  test('没配 GOOGLE_OAUTH_ENABLED 就是关的', () => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    expect(isGoogleOauthEnabled()).toBe(false);
  });

  test('只有 1 / true 算开，认不出的值一律按关处理', () => {
    for (const on of ['1', 'true', 'TRUE', ' true ']) {
      process.env.GOOGLE_OAUTH_ENABLED = on;
      expect(isGoogleOauthEnabled()).toBe(true);
    }
    // 打错字的代价必须是「功能没开」，不能是「凭据没配好就把入口暴露出去」
    for (const off of ['0', 'flase', 'yes', 'on', '', 'false']) {
      process.env.GOOGLE_OAUTH_ENABLED = off;
      expect(isGoogleOauthEnabled()).toBe(false);
    }
  });
});

// ───────────────────────── 配置 ─────────────────────────

describe('配置', () => {
  test('redirect_uri 由 LAWER_PUBLIC_URL 拼出，与要去 Google 控制台登记的一致', () => {
    expect(config().redirectUri).toBe(`${PUBLIC_URL}/api/v1/auth/google/callback`);
  });

  test('缺 LAWER_PUBLIC_URL 直接 503，绝不退回请求 origin（否则授权码会被 Host 头引走）', () => {
    delete process.env.LAWER_PUBLIC_URL;
    const read = readGoogleConfig();
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.status).toBe(503);
    // 三段式：撞到什么（缺哪一项）/ 为什么 / 怎么办
    expect(read.message).toContain('LAWER_PUBLIC_URL');
    expect(read.message).toContain('redirect_uri');
    expect(read.message).toContain('Google 控制台');
  });

  test('缺 client secret 时报错点名的是 secret，不是笼统一句"配置错误"', () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const read = readGoogleConfig();
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('GOOGLE_CLIENT_SECRET');
  });

  test('授权 URL 带齐 client_id / redirect_uri / state，且只要 openid email 两个 scope', () => {
    const url = new URL(buildAuthorizeUrl(config(), STATE));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/v1/auth/google/callback`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(STATE);
    // 多要一个 profile 就是多拿一份用不上的数据（users 表根本没有存昵称的列）
    expect(url.searchParams.get('scope')).toBe('openid email');
  });
});

describe('落地 URL', () => {
  test('🔴 JWT 走 fragment，绝不进 query（进 query 就等于把登录态写进反代日志）', () => {
    const url = successLandingUrl(config(), 'the.jwt.token', true);
    const [beforeHash, afterHash] = url.split('#');
    expect(beforeHash).toBe(`${PUBLIC_URL}/login`);
    // fragment 不会发给服务端，也不进 Referer
    expect(beforeHash).not.toContain('the.jwt.token');
    expect(new URLSearchParams(afterHash).get('google_token')).toBe('the.jwt.token');
    expect(new URLSearchParams(afterHash).get('is_new')).toBe('1');
  });

  test('失败也走 fragment，并把三段式原文一起带回登录页', () => {
    const url = failureLandingUrl(config(), {
      ok: false,
      status: 400,
      errorCode: 'GOOGLE_STATE_MISMATCH',
      message: '甲。乙。丙。',
    });
    const frag = new URLSearchParams(url.split('#')[1]);
    expect(frag.get('google_error')).toBe('GOOGLE_STATE_MISMATCH');
    expect(frag.get('google_message')).toBe('甲。乙。丙。');
  });

  test('🔴 google_message / google_error 进 fragment 前必须 percent-encode（改手工拼串即红）', () => {
    const nasty = '<img src=x onerror=alert(1)>&google_token=forged\r\nX-Injected: 1';
    const url = failureLandingUrl(config(), {
      ok: false,
      status: 400,
      errorCode: 'GOOGLE_AUTH_FAILED',
      message: nasty,
    });

    // 【判据本身】不是"值取得回来"，是**整条 URL 里不许出现这些生字符**：
    // 生的 `<` 会随文案原样落到页面 URL 上，生的 CR/LF 能撑破 Location 响应头，
    // 生的 `&` 能在 fragment 里另造一个键（下面那条断言正是冲 google_token 去的）。
    for (const raw of ['<', '>', '\r', '\n']) expect(url).not.toContain(raw);
    expect(url).toContain('%3Cimg');
    expect(url).toContain('%0D%0A');

    const frag = new URLSearchParams(url.split('#')[1]);
    expect(frag.get('google_message')).toBe(nasty); // 编码可逆，文案本身没被改写
    expect(frag.get('google_token')).toBeNull(); // 伪造不出第二个键
    expect([...frag.keys()].sort()).toEqual(['google_error', 'google_message']);
  });

  test('🔴 成功路径的 fragment 同样只允许两个键（token 不许被文案挤出第三个键）', () => {
    const url = successLandingUrl(config(), 'a.b.c&is_new=9', true);
    const frag = new URLSearchParams(url.split('#')[1]);
    expect([...frag.keys()].sort()).toEqual(['google_token', 'is_new']);
    expect(frag.get('is_new')).toBe('1');
  });
});

// ───────────────────────── state 防 CSRF ─────────────────────────

describe('state 校验（防登录 CSRF）', () => {
  test('🔴 state 与 cookie 不一致 → 拒绝，且一次外呼都没发生', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    const res = await callback(db, { state: 'attacker-state', cookieState: STATE }, log);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_STATE_MISMATCH');
    // 【判据本身】state 不过就绝不能替这条链接去跟 Google 换 token。
    // 只断言"返回了错误"是不够的：先换了 token 再报错，一样能让那条断言绿着。
    expect(log.calls).toHaveLength(0);
    expect(userCount(db)).toBe(0);
  });

  test('🔴 两边都是空串不算匹配（空 cookie 必须判失败，不是"都空就放行"）', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    const res = await callback(db, { state: '', cookieState: '' }, log);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_STATE_MISMATCH');
    expect(log.calls).toHaveLength(0);
  });

  test('浏览器没带 cookie（被拦/过期）→ 判失败，不放行', async () => {
    const db = makeTestDb();
    const res = await callback(db, { cookieState: '' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_STATE_MISMATCH');
  });

  test('state 失败文案是三段式：撞到什么 / 为什么 / 怎么办', async () => {
    const db = makeTestDb();
    const res = await callback(db, { state: 'x', cookieState: 'y' });
    if (res.ok) throw new Error('前置失败：本该被拒');
    expect(res.message).toContain('跨站伪造');
    expect(res.message).toContain('10 分钟');
    expect(res.message).toContain('重新点一次');
  });

  test('前缀不算匹配：statesMatch 不能被截短的 state 骗过去', () => {
    expect(statesMatch('abcd', 'abcd')).toBe(true);
    expect(statesMatch('abcd', 'abc')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch('', '')).toBe(false);
    expect(statesMatch('abcd', '')).toBe(false);
  });

  test('每次 createOauthState 都不一样，且够长（猜得到就等于没防）', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createOauthState()));
    expect(seen.size).toBe(200);
    expect(createOauthState().length).toBeGreaterThanOrEqual(20);
  });

  test('state 一致就放行，并且确实去换了 token', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    const res = await callback(db, {}, log);
    expect(res.ok).toBe(true);
    expect(log.calls).toHaveLength(1);
  });

  test('用户在 Google 页面点了取消 → 不当作系统故障，也不去换 token', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    const res = await callback(db, { error: 'access_denied' }, log);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_CANCELLED');
    expect(log.calls).toHaveLength(0);
  });
});

// ──────────────── error 分支必须在 state 闸门之内（顺序即判据）────────────────

/**
 * 这一节钉的是**三条判断的先后次序**，不是它们各自的返回值。
 *
 * 顺序一旦变回 `error → state`，`error` 分支就完全落在 state 闸门之外：
 * `GET /callback?error=<任意文本>` 不带 cookie、不带 state、不带 code 也能命中 302，
 * 把攻击者自造的文本挂到本站真实域名的 /login 上（RFC 6749 §4.1.2.1 规定 Google
 * 连报错回调都必带 state，所以这个顺序没有任何正当理由）。
 * 只断言"取消时回 GOOGLE_CANCELLED"是拦不住这条的——那条断言在两种顺序下都绿。
 */
describe('error 分支必须在 state 闸门之内', () => {
  /** 复审官 PoC 的原文：钓鱼话术 + XSS 载荷 */
  const PHISHING = '您的账号存在异常已被冻结，请添加客服微信 wx-9527 解冻<img src=x onerror=alert(1)>';

  test('🔴 无 cookie / 无 state / 无 code 时 ?error=<任意文本> → 只能回 STATE_MISMATCH', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    const res = await callback(
      db,
      { error: PHISHING, state: '', cookieState: '', code: '' },
      log,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 【判据本身】不是"回了个错误"——是回的**必须是 state 那条**：
    // 回 GOOGLE_AUTH_FAILED 就说明 error 分支又抢在 state 前面了
    expect(res.errorCode).toBe('GOOGLE_STATE_MISMATCH');
    expect(res.message).toBe(
      '这次 Google 登录的来路没能验证通过（防跨站伪造的一次性凭据对不上），已经中止。' +
        '通常是登录页开着超过 10 分钟才点完、中途换了浏览器或标签页、或者浏览器拦了本站 cookie；' +
        '也可能是有人把一条伪造的登录链接发给了你。' +
        '请回到本站登录页重新点一次「使用 Google 登录」，不要从别处收到的链接进入。',
    );
    expect(log.calls).toHaveLength(0);
  });

  test('🔴 复审官 PoC：落地 URL 里一个字的攻击者文本都不许出现', async () => {
    const db = makeTestDb();
    const res = await callback(db, { error: PHISHING, state: '', cookieState: '', code: '' });
    if (res.ok) throw new Error('前置失败：本该被 state 拦下');

    const url = failureLandingUrl(config(), res);
    // 逐词核，而不是核整串——编码后整串本来就对不上，逐词才是真的在找回显
    for (const word of ['冻结', '客服微信', 'wx-9527', 'img', 'onerror', 'alert']) {
      expect(url).not.toContain(word);
      expect(url).not.toContain(encodeURIComponent(word));
    }
    expect(new URLSearchParams(url.split('#')[1]).get('google_error')).toBe(
      'GOOGLE_STATE_MISMATCH',
    );
  });

  test('🔴 10KB 的 error 也照样在闸门外被截住（长度不设限的反射面归零）', async () => {
    const db = makeTestDb();
    const res = await callback(db, { error: 'A'.repeat(10240), state: '', cookieState: '' });
    if (res.ok) throw new Error('前置失败：本该被 state 拦下');
    expect(res.errorCode).toBe('GOOGLE_STATE_MISMATCH');
    expect(res.message.length).toBeLessThan(400);
  });

  test('🔴 state 对上之后，形状不合的原因代码仍不回显（白名单是第二道）', async () => {
    const db = makeTestDb();
    const res = await callback(db, { error: PHISHING, state: STATE, cookieState: STATE });
    if (res.ok) throw new Error('前置失败：本该失败');
    expect(res.errorCode).toBe('GOOGLE_AUTH_FAILED');
    expect(res.message).not.toContain('客服微信');
    expect(res.message).not.toContain('<img');
    expect(res.message).toContain('形状不合');
  });

  test('形状合规的 Google 错误码照常回显，运维才定位得了', async () => {
    const db = makeTestDb();
    const res = await callback(db, {
      error: 'admin_policy_enforced',
      state: STATE,
      cookieState: STATE,
    });
    if (res.ok) throw new Error('前置失败：本该失败');
    expect(res.message).toContain('admin_policy_enforced');
  });
});

describe('readCookie', () => {
  test('从一堆 cookie 里挑出目标那条，不被前缀相同的名字骗到', () => {
    const header = 'other=1; lawer_google_state_x=wrong; lawer_google_state=right; z=2';
    expect(readCookie(header, 'lawer_google_state')).toBe('right');
  });

  test('没有这条 / 头为空 → 空串（调用方按 state 不匹配处理）', () => {
    expect(readCookie('a=1', 'lawer_google_state')).toBe('');
    expect(readCookie(null, 'lawer_google_state')).toBe('');
  });

  test('🔴 同名多条时取**第一条**（改成取最后一条即红）', () => {
    // RFC 6265 §5.4：Path 更长的排在前面。我们这条是 Path=/api/v1/auth/google，
    // 会排在攻击者从同域某处植入的 Path=/ 同名 cookie 之前。取最后一条 =
    // 把优先权让给被植入的那条，state 校验就成了攻击者说了算。（复审官 B9）
    const header = 'lawer_google_state=ours; lawer_google_state=planted';
    expect(readCookie(header, 'lawer_google_state')).toBe('ours');
    // 三条也一样，且中间夹着别的 cookie 不影响
    expect(
      readCookie('lawer_google_state=ours; a=1; lawer_google_state=p2; lawer_google_state=p3', 'lawer_google_state'),
    ).toBe('ours');
  });
});

// ───────────────────────── 换 token ─────────────────────────

describe('授权码换 token', () => {
  test('POST 到 token 端点，带齐 grant_type / code / redirect_uri', async () => {
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    await callback(db, { code: 'the-code' }, log);

    expect(log.calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(log.calls[0].body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('the-code');
    // redirect_uri 必须与授权时那次逐字一致，否则 Google 直接拒
    expect(sent.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/v1/auth/google/callback`);
    expect(sent.get('client_id')).toBe(CLIENT_ID);
    expect(sent.get('client_secret')).toBe('test-client-secret');
  });

  test('GOOGLE_TOKEN_ENDPOINT 配了就走中继（大陆机房直连不通时的出口）', async () => {
    process.env.GOOGLE_TOKEN_ENDPOINT = 'https://relay.example.com/token';
    const db = makeTestDb();
    const log: FetchLog = { calls: [] };
    await callback(db, {}, log);
    expect(log.calls[0].url).toBe('https://relay.example.com/token');
  });

  test('token 端点回非 200 → 502，且不建号', async () => {
    const db = makeTestDb();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await completeGoogleCallback(
      db,
      config(),
      { code: 'c', state: STATE, cookieState: STATE },
      {
        fetchImpl: (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as
          unknown as typeof fetch,
        now: NOW,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_EXCHANGE_FAILED');
    expect(userCount(db)).toBe(0);
  });

  test('端点连不上（抛异常）→ 502，不炸成未捕获异常', async () => {
    const db = makeTestDb();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await completeGoogleCallback(
      db,
      config(),
      { code: 'c', state: STATE, cookieState: STATE },
      {
        fetchImpl: (async () => {
          throw new Error('ETIMEDOUT');
        }) as unknown as typeof fetch,
        now: NOW,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_EXCHANGE_FAILED');
    // 三段式里要点出"这一步是服务器直连 Google"，否则运维只会去查用户网络
    expect(res.message).toContain('服务器');
  });

  test('回包里没有 id_token → 502，不当成登录成功', async () => {
    const db = makeTestDb();
    const res = await completeGoogleCallback(
      db,
      config(),
      { code: 'c', state: STATE, cookieState: STATE },
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ access_token: 'a' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
        now: NOW,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('GOOGLE_EXCHANGE_FAILED');
    expect(userCount(db)).toBe(0);
  });
});

// ───────────────────────── id_token 校验 ─────────────────────────

describe('id_token claim 校验（鉴权强度，逐条都不许放宽）', () => {
  const parse = (over: Record<string, unknown>) =>
    parseIdTokenFromTokenEndpoint(idToken(over), CLIENT_ID, NOW);

  test('aud 不是本站 client_id → 拒（别人家的 token 不能进我们的门）', () => {
    const res = parse({ aud: 'someone-else.apps.googleusercontent.com' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('GOOGLE_TOKEN_INVALID');
  });

  test('aud 是数组也拒（Google 发的是字符串，收窄不是漏判）', () => {
    const res = parse({ aud: [CLIENT_ID] });
    expect(res.ok).toBe(false);
  });

  test('🔴 aud 必须**恰好等于**，含有/前缀/后缀都不算（把 === 放宽成 includes 即红）', () => {
    // 上面那条用的是一个完全无关的 aud，区分不出「等于 / 包含 / 前缀」三种实现——
    // 注释写着"恰好等于"，判据得真的钉住它。（复审官 A3）
    for (const near of [
      `x${CLIENT_ID}`,
      `${CLIENT_ID}x`,
      `${CLIENT_ID} ${CLIENT_ID}`,
      CLIENT_ID.slice(0, -1),
      ` ${CLIENT_ID} `,
    ]) {
      const res = parse({ aud: near });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe('GOOGLE_TOKEN_INVALID');
    }
    expect(parse({ aud: CLIENT_ID }).ok).toBe(true);
  });

  test('iss 不是 Google → 拒', () => {
    expect(parse({ iss: 'https://evil.example.com' }).ok).toBe(false);
    // 两种历史取值都要收
    expect(parse({ iss: 'accounts.google.com' }).ok).toBe(true);
  });

  test('exp 已过期 → 拒；exp 缺失也拒（不按"没写就是不过期"处理）', () => {
    expect(parse({ exp: Math.floor(NOW.getTime() / 1000) - 1 }).ok).toBe(false);
    expect(parse({ exp: undefined }).ok).toBe(false);
    expect(parse({ exp: '9999999999' }).ok).toBe(false);
  });

  test('🔴 email_verified 只认布尔 true —— 这是拦住"拿别人邮箱开别人账号"的唯一一条', () => {
    for (const bad of [false, 'true', 1, undefined, null]) {
      const res = parse({ email_verified: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe('GOOGLE_EMAIL_UNVERIFIED');
    }
    expect(parse({ email_verified: true }).ok).toBe(true);
  });

  test('email 缺失或空 → 拒（没有邮箱就没有可归并的键）', () => {
    expect(parse({ email: undefined }).ok).toBe(false);
    expect(parse({ email: '   ' }).ok).toBe(false);
  });

  test('sub 缺失 → 拒', () => {
    expect(parse({ sub: '' }).ok).toBe(false);
    expect(parse({ sub: undefined }).ok).toBe(false);
  });

  test('邮箱归一化成小写，好和邮箱线存的那份对得上', () => {
    const res = parse({ email: '  ZhAnG@Example.COM  ' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.email).toBe('zhang@example.com');
  });

  test('不是 JWT 形状 → 拒，不抛异常', () => {
    expect(parseIdTokenFromTokenEndpoint('nonsense', CLIENT_ID, NOW).ok).toBe(false);
    expect(parseIdTokenFromTokenEndpoint('a.b', CLIENT_ID, NOW).ok).toBe(false);
    expect(parseIdTokenFromTokenEndpoint('a.!!!.c', CLIENT_ID, NOW).ok).toBe(false);
  });
});

// ───────────────────────── 新邮箱开户 ─────────────────────────

describe('新邮箱开户', () => {
  test('🔴 新账号建出来就能用（判据是过得了计费门槛，不是账本里有行）', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.isNew).toBe(true);
    // 没有注册赠送的话这里恒为 false —— 那正是 2026-08-28 产线上两个真实账号的处境
    expect(gongdaoGate(res.userId, db)).toBe(true);
    expect(getGongdao(res.userId, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('账本落的是「注册赠送」，refId 一人一次', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    const rows = db
      .prepare('SELECT type, delta, ref_id FROM gongdao_ledger WHERE user_id=?')
      .all(res.userId) as { type: string; delta: number; ref_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: GONGDAO_LEDGER_TYPE.register,
      delta: REGISTER_GRANT_GONGDAO,
      ref_id: `reg-${res.userId}`,
    });
  });

  test('落库的是 google_sub + 已验证邮箱，没有手机号也建得起来', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    const row = db
      .prepare('SELECT email, email_verified_at, google_sub, phone_hash FROM users WHERE id=?')
      .get(res.userId) as {
      email: string;
      email_verified_at: string | null;
      google_sub: string;
      phone_hash: string | null;
    };
    expect(row.email).toBe(EMAIL);
    expect(row.google_sub).toBe(SUB);
    // Google 已经替我们验过这个邮箱，不该再逼用户收一遍验证码
    expect(row.email_verified_at).not.toBeNull();
    expect(row.phone_hash).toBeNull();
  });

  test('签发的 token 解出来就是这个 uid', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    expect(verifyToken(res.token, NOW)?.uid).toBe(res.userId);
  });

  test('🔴 同一个 Google 账号再登一次：不新建账号、不二次发钱', async () => {
    const db = makeTestDb();
    const first = await callback(db);
    const second = await callback(db);
    if (!first.ok || !second.ok) throw new Error('前置失败');

    expect(second.userId).toBe(first.userId);
    expect(second.isNew).toBe(false);
    expect(userCount(db)).toBe(1);
    expect(getGongdao(first.userId, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('Google 那边改了邮箱，回来还是同一个账号（归并键是 sub 不是邮箱）', async () => {
    const db = makeTestDb();
    const first = await callback(db);
    const second = await callback(db, { token: idToken({ email: 'new-address@example.com' }) });
    if (!first.ok || !second.ok) throw new Error('前置失败');
    expect(second.userId).toBe(first.userId);
    expect(userCount(db)).toBe(1);
  });

  test('🔴 建号与注册赠送同生同死：赠送炸了不该留下一个用不了的账号', async () => {
    const db = makeTestDb();
    const real = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO gongdao_ledger')) {
        throw new Error('模拟账本写入失败');
      }
      return real(sql);
    }) as typeof db.prepare);

    await expect(callback(db)).rejects.toThrow();
    vi.restoreAllMocks();
    expect(userCount(db)).toBe(0);
  });
});

// ───────────────────────── 既有邮箱绑定 ─────────────────────────

/** 用真的手机线 + 邮箱线注册一个存量账号，返回 uid */
async function registerByPhoneAndEmail(db: Db, phone: string, email: string): Promise<number> {
  const t0 = new Date('2026-08-30T00:00:00.000Z');
  await sendPhoneCode(db, { phone, ip: '203.0.113.9' }, { sendSms: async () => {}, now: t0 });
  const smsCode = lastSmsCode(db, hashLookup(phone));
  const phoneRes = verifyPhoneCode(db, { phone, code: smsCode }, { now: t0 });
  if (!phoneRes.ok) throw new Error('前置失败：手机线注册没走通');
  const uid = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number })
    .id;

  await sendEmailCode(
    db,
    { userId: uid, email, ip: '203.0.113.9' },
    { sendEmail: async () => {}, now: t0 },
  );
  const emailCode = lastEmailCode(db, email);
  const emailRes = verifyEmailCode(db, { userId: uid, email, code: emailCode }, { now: t0 });
  if (!emailRes.ok) throw new Error('前置失败：邮箱线验证没走通');
  return uid;
}

describe('既有邮箱绑定', () => {
  test('🔴 老账号用 Google 登进来：不新建账号，旧案件还在他自己名下', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    const { caseId } = ensureDefaultCase(db, uid);

    const res = await callback(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 【判据本身】新建一个账号也能让 res.ok 为真——真正会出事的是"他上次存的材料看不见了"
    expect(res.userId).toBe(uid);
    expect(res.isNew).toBe(false);
    expect(userCount(db)).toBe(1);
    const owner = db.prepare('SELECT user_id FROM cases WHERE id=?').get(caseId) as {
      user_id: number;
    };
    expect(owner.user_id).toBe(uid);
  });

  test('绑定后 google_sub 落到那一行上，下次直接按 sub 命中', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    await callback(db);

    const row = db.prepare('SELECT google_sub FROM users WHERE id=?').get(uid) as {
      google_sub: string;
    };
    expect(row.google_sub).toBe(SUB);

    const again = await callback(db);
    if (!again.ok) throw new Error('前置失败');
    expect(again.userId).toBe(uid);
    expect(userCount(db)).toBe(1);
  });

  test('绑定不发第二份注册赠送（他注册时已经领过了）', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    const before = getGongdao(uid, db);
    await callback(db);
    expect(getGongdao(uid, db)).toBe(before);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM gongdao_ledger WHERE user_id=?').get(uid) as { c: number })
        .c,
    ).toBe(1);
  });

  test('🔴 邮箱已绑另一个 Google 账号 → 拒，且绝不改写既有绑定', async () => {
    const db = makeTestDb();
    const first = await callback(db);
    if (!first.ok) throw new Error('前置失败');

    // 同一个邮箱、不同的 Google sub
    const res = await callback(db, { token: idToken({ sub: 'another-google-sub' }) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.errorCode).toBe('GOOGLE_ACCOUNT_CONFLICT');

    // 既有绑定原封不动，也没有多出一个账号
    expect(userCount(db)).toBe(1);
    expect(
      (db.prepare('SELECT google_sub FROM users WHERE id=?').get(first.userId) as {
        google_sub: string;
      }).google_sub,
    ).toBe(SUB);
  });

  test('冲突文案三段式，并给出"用邮箱验证码进同一个档案"这条出路', async () => {
    const db = makeTestDb();
    await callback(db);
    const res = await callback(db, { token: idToken({ sub: 'another-google-sub' }) });
    if (res.ok) throw new Error('前置失败：本该冲突');
    expect(res.message).toContain('已经有账号');
    expect(res.message).toContain('两把钥匙');
    expect(res.message).toContain('邮箱验证码');
  });

  test('手机线老账号没验过邮箱（email 为空）→ 按新用户建号，不会归并到空邮箱那行上', async () => {
    const db = makeTestDb();
    const t0 = new Date('2026-08-30T00:00:00.000Z');
    await sendPhoneCode(
      db,
      { phone: '13800138000', ip: '203.0.113.9' },
      { sendSms: async () => {}, now: t0 },
    );
    const code = lastSmsCode(db, hashLookup('13800138000'));
    verifyPhoneCode(db, { phone: '13800138000', code }, { now: t0 });

    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    expect(res.isNew).toBe(true);
    expect(userCount(db)).toBe(2);
  });

  test('大小写不同的邮箱也归并到同一行（Google 回 Uppercase 时不该开出第二个账号）', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    const res = await callback(db, { token: idToken({ email: 'ZHANG@EXAMPLE.COM' }) });
    if (!res.ok) throw new Error('前置失败');
    expect(res.userId).toBe(uid);
    expect(userCount(db)).toBe(1);
  });

  test('🔴 抢先绑定时不认领：回查不到同一个 sub 就判冲突，绝不猜"应该是自己绑的"', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    // 模拟「SELECT 之后、UPDATE 之前被人插队」：守卫没命中，bindGoogleSub 回 false
    vi.spyOn(store, 'bindGoogleSub').mockReturnValue(false);

    const res = await callback(db);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 猜错的后果是把 A 的 Google 账号记到 B 的档案上——宁可报冲突
    expect(res.errorCode).toBe('GOOGLE_ACCOUNT_CONFLICT');
    expect(
      (db.prepare('SELECT google_sub FROM users WHERE id=?').get(uid) as {
        google_sub: string | null;
      }).google_sub,
    ).toBeNull();
  });
});

// ───────────────────────── 库层兜底与建档 ─────────────────────────

describe('库层唯一索引', () => {
  test('🔴 同一个 google_sub 绑不到两个账号上（应用层判断之外的最后一道）', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');

    const other = db
      .prepare("INSERT INTO users (email, created_at) VALUES ('other@example.com', '2026-08-31')")
      .run();
    // 绕开应用层直接写库：唯一索引必须拦住
    expect(() =>
      db
        .prepare('UPDATE users SET google_sub = ? WHERE id = ?')
        .run(SUB, other.lastInsertRowid),
    ).toThrow();
  });

  test('没绑 Google 的账号可以有很多个（部分索引：多行 NULL 不算冲突）', () => {
    const db = makeTestDb();
    for (const mail of ['a@example.com', 'b@example.com', 'c@example.com']) {
      db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run(mail, '2026-08-31');
    }
    expect(userCount(db)).toBe(3);
  });
});

describe('登录后补建档案', () => {
  test('🔴 Google 新用户当场就有档案可用（不因为没手机号而成二等公民）', async () => {
    const db = makeTestDb();
    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    expect(res.isNew).toBe(true);

    // 【判据本身】不是"provisionOnRegistered 被调了"——是这个人**真的有案件**。
    // 判据留在 lib/auth/otp.ts provisionOnRegistered 那一处（唯一住址），
    // 这里验的是 Google 新用户确实落在它的收治范围里。
    const cases = db.prepare('SELECT id FROM cases WHERE user_id=?').all(res.userId) as {
      id: number;
    }[];
    expect(cases).toHaveLength(1);
    // 建档不是空壳：欢迎事件在同一事务里，缺了就是半截档案
    expect(
      (
        db.prepare('SELECT COUNT(*) c FROM timeline_events WHERE case_id=?').get(cases[0].id) as {
          c: number;
        }
      ).c,
    ).toBeGreaterThanOrEqual(1);
    // 与手机/邮箱线同等待遇的另一半：注册赠送也拿到了
    expect(getGongdao(res.userId, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('🔴 建档幂等：同一个 Google 账号再登一次不会多出第二个案件', async () => {
    const db = makeTestDb();
    const first = await callback(db);
    await callback(db);
    if (!first.ok) throw new Error('前置失败');
    expect(
      (
        db.prepare('SELECT COUNT(*) c FROM cases WHERE user_id=?').get(first.userId) as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });


  test('🔴 注册时建案失败过的账号，这次 Google 登录把档案补上', async () => {
    const db = makeTestDb();
    const uid = await registerByPhoneAndEmail(db, '13800138000', EMAIL);
    // 复现 otp.ts provisionOnRegistered 明确容忍的那种历史状态：
    // 注册当时 ensureDefaultCase 抛了错，登录没被阻断，于是这个人手里没有案件
    db.prepare('DELETE FROM timeline_events WHERE case_id IN (SELECT id FROM cases WHERE user_id=?)').run(uid);
    db.prepare('DELETE FROM cases WHERE user_id = ?').run(uid);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM cases WHERE user_id=?').get(uid) as { c: number }).c,
    ).toBe(0);

    const res = await callback(db);
    if (!res.ok) throw new Error('前置失败');
    expect(res.userId).toBe(uid);
    // 【判据本身】登录成功不算数——这个人得真的有档案可用
    expect(
      (db.prepare('SELECT COUNT(*) c FROM cases WHERE user_id=?').get(uid) as { c: number }).c,
    ).toBe(1);
  });
});
