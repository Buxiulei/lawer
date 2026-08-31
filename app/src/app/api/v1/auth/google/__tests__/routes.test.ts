// app/src/app/api/v1/auth/google/__tests__/routes.test.ts
// 两条 Google 路由的形状判据：暗启期的 404、302 的去处、state cookie 的属性。
//
// 业务分支（归并/建号/换 token）在 lib/auth/__tests__/google.test.ts 里覆盖，
// 这里只钉路由层自己负责的事——尤其是**开关关着时到底回什么**。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

type Handler = (req: Request) => Promise<Response>;
let start: Handler;
let callback: Handler;

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const PUBLIC_URL = 'https://law.example.com';

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'GET', headers });
}

/** 从响应里取 Set-Cookie（可能有多条，取带我们这个名字的那条） */
function stateCookie(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return all.find((c) => c.startsWith('lawer_google_state=')) ?? '';
}

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  // client.ts 在模块加载时读 DB_PATH，故先设再 import（照 auth/__tests__/routes.test.ts）
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-google-routes-${crypto.randomUUID()}.db`);
  start = (await import('../start/route')).GET as unknown as Handler;
  callback = (await import('../callback/route')).GET;
});

beforeEach(() => {
  process.env.GOOGLE_OAUTH_ENABLED = '1';
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.LAWER_PUBLIC_URL = PUBLIC_URL;
});

describe('开关关着时两条路由都不存在', () => {
  test('🔴 GOOGLE_OAUTH_ENABLED 没配 → 两条都 404', async () => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    for (const res of [
      await start(get('http://localhost/api/v1/auth/google/start')),
      await callback(get('http://localhost/api/v1/auth/google/callback?code=c&state=s')),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  test('🔴 404 的响应体不能泄露"这里将来有个 Google 登录"', async () => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(await res.text()).toBe('');
  });

  test('关着时哪怕凭据都配好了，也还是 404（开关是开关，不是"配了就算开"）', async () => {
    process.env.GOOGLE_OAUTH_ENABLED = '0';
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(res.status).toBe(404);
  });

  test('关着时不下发任何 cookie', async () => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(stateCookie(res)).toBe('');
  });
});

describe('GET /start', () => {
  test('302 到 Google，并把 state 同时放进 URL 和 cookie', async () => {
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const urlState = location.searchParams.get('state') ?? '';
    expect(urlState).not.toBe('');

    // 【判据本身】cookie 里那份必须和 URL 里那份是同一个值，
    // 否则回调时自己跟自己对不上，每一次正常登录都会被判成 CSRF
    const cookie = stateCookie(res);
    expect(cookie).toContain(`lawer_google_state=${encodeURIComponent(urlState)};`);
  });

  test('🔴 state cookie 是 HttpOnly + SameSite=Lax（Strict 会让每次登录都失败）', async () => {
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    const cookie = stateCookie(res);
    expect(cookie).toContain('HttpOnly');
    // 从 Google 跳回来是跨站顶层导航：Strict 不带 cookie ⇒ 正常登录全判成 state 不匹配
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=600');
    // 基址是 https 就必须带 Secure
    expect(cookie).toContain('Secure');
  });

  test('本地开发（http 基址）不加 Secure，否则浏览器根本不存这条 cookie', async () => {
    process.env.LAWER_PUBLIC_URL = 'http://localhost:3000';
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(stateCookie(res)).not.toContain('Secure');
  });

  test('两次请求拿到的 state 不一样（不是写死的常量）', async () => {
    const a = await start(get('http://localhost/api/v1/auth/google/start'));
    const b = await start(get('http://localhost/api/v1/auth/google/start'));
    const stateOf = (res: Response) =>
      new URL(res.headers.get('location') ?? '').searchParams.get('state');
    expect(stateOf(a)).not.toBe(stateOf(b));
  });

  test('开关开着但凭据没配齐 → 503 三段式，不是 404（这两种情况运维要能分得开）', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await start(get('http://localhost/api/v1/auth/google/start'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_code).toBe('GOOGLE_OAUTH_MISCONFIGURED');
    expect(body.message).toContain('GOOGLE_CLIENT_ID');
  });
});

describe('GET /callback', () => {
  test('🔴 state 对不上 → 302 回登录页，错误原文走 fragment', async () => {
    const res = await callback(
      get('http://localhost/api/v1/auth/google/callback?code=c&state=attacker', {
        cookie: 'lawer_google_state=real-one',
      }),
    );
    expect(res.status).toBe(302);

    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(`${PUBLIC_URL}/login#`)).toBe(true);
    const frag = new URLSearchParams(location.split('#')[1]);
    expect(frag.get('google_error')).toBe('GOOGLE_STATE_MISMATCH');
    expect(frag.get('google_message')).toContain('跨站伪造');
    // 失败时绝不能有 token
    expect(frag.get('google_token')).toBeNull();
  });

  test('🔴 回调不论成败都把 state cookie 焚掉（一个 state 只能换一次登录）', async () => {
    const res = await callback(
      get('http://localhost/api/v1/auth/google/callback?code=c&state=x', {
        cookie: 'lawer_google_state=y',
      }),
    );
    expect(stateCookie(res)).toContain('Max-Age=0');
  });

  test('完全没带 cookie 也不放行，且不 500', async () => {
    const res = await callback(
      get('http://localhost/api/v1/auth/google/callback?code=c&state=x'),
    );
    expect(res.status).toBe(302);
    const frag = new URLSearchParams((res.headers.get('location') ?? '').split('#')[1]);
    expect(frag.get('google_error')).toBe('GOOGLE_STATE_MISMATCH');
  });

  test('🔴 复审官 PoC：无 cookie/state/code 的 ?error=<任意文本> 不回显一个字', async () => {
    // 修复前：这条请求直接命中 error 分支，302 的 Location 里带着攻击者原文，
    // 于是本站真实域名上多了一块任意文案投放位（「加客服微信解冻」+ XSS 载荷）。
    const phishing = '您的账号存在异常已被冻结，请添加客服微信 wx-9527 解冻<img src=x onerror=alert(1)>';
    const res = await callback(
      get(
        `http://localhost/api/v1/auth/google/callback?error=${encodeURIComponent(phishing)}`,
      ),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    // 逐词核：编码后整串对不上，逐词才是真的在找回显
    for (const word of ['冻结', '客服微信', 'wx-9527', 'img', 'onerror', 'alert']) {
      expect(location).not.toContain(word);
      expect(location).not.toContain(encodeURIComponent(word));
    }
    const frag = new URLSearchParams(location.split('#')[1]);
    expect(frag.get('google_error')).toBe('GOOGLE_STATE_MISMATCH');
    expect(frag.get('google_token')).toBeNull();
    // 生的 CR/LF 撑不破 Location 头
    expect(location).not.toContain('\r');
    expect(location).not.toContain('\n');
  });

  test('用户在 Google 点了取消 → 送回登录页并说明，不留在白屏上', async () => {
    const res = await callback(
      get('http://localhost/api/v1/auth/google/callback?error=access_denied&state=x', {
        cookie: 'lawer_google_state=x',
      }),
    );
    expect(res.status).toBe(302);
    const frag = new URLSearchParams((res.headers.get('location') ?? '').split('#')[1]);
    expect(frag.get('google_error')).toBe('GOOGLE_CANCELLED');
    expect(frag.get('google_message')).toContain('手机号');
  });
});
