// app/src/app/api/oauth/__tests__/oauth.test.ts
// OAuth 2.1 授权服务器的判据。
//
// 这一面没有 SDK 兜底，也没有"跑起来就知道错了"的兜底——**放宽了的那一版照常走通**：
// 去掉 PKCE 校验、让 code 可重用、把白名单改成前缀匹配、refresh 不旋转，四种改法之后
// 「添加连接器 → 登录 → 同意 → 用起来」这条路一模一样地成功。所以每一条都得单独钉。
//
// 一条端到端（注册 → authorize → 同意 → code → token → 用 token 调 tools/list →
// refresh → revoke → 401）钉的是"这条路真的能走通"；其余各条钉的是"该拒的真的拒了"。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

type Handler = (req: Request) => Promise<Response>;

let registerPost: Handler;
let authorizeGet: Handler;
let authorizePost: Handler;
let tokenPost: Handler;
let revokePost: Handler;
let asMetadataGet: Handler;
let prMetadataGet: Handler;
let mcpPost: Handler;
let keysGet: Handler;
let signToken: (uid: number, now?: Date) => string;
let db: Database;

let userA: number;
let userB: number;
let caseA: number;
let jwtA: string;

const REDIRECT = 'https://client.example.com/oauth/callback';

/** PKCE 一对：verifier 取 43 字符下限之上的随机串，challenge = BASE64URL(SHA256(verifier)) */
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(40).toString('base64url'); // 54 字符
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery(over: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: 'PLACEHOLDER',
    redirect_uri: REDIRECT,
    code_challenge_method: 'S256',
    state: 'st-123',
    ...over,
  }).toString();
}

async function registerClient(redirectUris: string[] = [REDIRECT]): Promise<string> {
  const res = await registerPost(
    new Request('http://localhost/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: '某网页版助手', redirect_uris: redirectUris }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** 走完「打开授权页 → 同意」，拿回授权码。jwt 不传则用甲的登录态。 */
async function consent(
  query: string,
  jwt: string | null = jwtA,
): Promise<{ status: number; body: Record<string, string> }> {
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const res = await authorizePost(
    new Request('http://localhost/api/oauth/authorize', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

function codeOf(redirectTo: string): string {
  return new URL(redirectTo).searchParams.get('code')!;
}

async function postToken(form: Record<string, string>) {
  const res = await tokenPost(
    new Request('http://localhost/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** 用一串 Bearer 调 MCP 的 tools/list；返回 HTTP 状态与回包 */
async function toolsList(bearer: string) {
  const res = await mcpPost(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 走一遍完整授权，返回 { clientId, verifier, access, refresh, keyId } */
async function fullGrant() {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const query = authorizeQuery({ client_id: clientId, code_challenge: challenge });
  const approved = await consent(query);
  expect(approved.status).toBe(200);
  const code = codeOf(approved.body.redirect_to);
  const tok = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(tok.status).toBe(200);
  const keyId = (
    db.prepare('SELECT key_id FROM oauth_codes ORDER BY id DESC LIMIT 1').get() as {
      key_id: number;
    }
  ).key_id;
  return {
    clientId,
    verifier,
    code,
    access: tok.body.access_token,
    refresh: tok.body.refresh_token,
    keyId,
  };
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-oauth-${crypto.randomUUID()}.db`);

  registerPost = (await import('../register/route')).POST;
  const authorize = await import('../authorize/route');
  authorizeGet = authorize.GET;
  authorizePost = authorize.POST;
  tokenPost = (await import('../token/route')).POST;
  revokePost = (await import('../revoke/route')).POST;
  asMetadataGet = (await import('../metadata/authorization-server/route')).GET;
  prMetadataGet = (await import('../metadata/protected-resource/route')).GET;
  mcpPost = (await import('../../mcp/route')).POST;
  keysGet = (await import('../../v1/keys/route')).GET;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of [
    'oauth_tokens', 'oauth_codes', 'oauth_clients',
    'api_keys', 'timeline_events', 'action_items', 'cases',
    'token_usage', 'gongdao_ledger', 'gongdao', 'users',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '甲的档案')").run(userA)
      .lastInsertRowid,
  );
  jwtA = signToken(userA);
});

describe('元数据', () => {
  test('授权服务器元数据登记的都是真有的东西，且 PKCE 只写 S256', async () => {
    const meta = (await (await asMetadataGet(new Request('http://localhost/'))).json()) as Record<
      string,
      unknown
    >;
    expect(meta.issuer).toBe('http://localhost');
    expect(meta.authorization_endpoint).toBe('http://localhost/oauth/authorize');
    expect(meta.token_endpoint).toBe('http://localhost/api/oauth/token');
    expect(meta.registration_endpoint).toBe('http://localhost/api/oauth/register');
    // plain 出现在这里，就等于允许客户端选一个没有 PKCE 保护的流程
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  test('受保护资源元数据指回本授权服务器', async () => {
    const meta = (await (await prMetadataGet(new Request('http://localhost/'))).json()) as Record<
      string,
      unknown
    >;
    expect(meta.resource).toBe('http://localhost/api/mcp');
    expect(meta.authorization_servers).toEqual(['http://localhost']);
  });

  test('MCP 401 带 resource_metadata —— 只认 OAuth 的客户端靠它找到授权服务器', async () => {
    const res = await mcpPost(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });
});

describe('端到端：注册 → 授权 → 令牌 → 调用 → 续期 → 交还', () => {
  test('一次走通，且每一步的产物都真的能用', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery({ client_id: clientId, code_challenge: challenge });

    // 同意页拿到的是"谁在申请、要什么权限"，此时还没有任何凭据被签发
    const infoRes = await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`));
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as { client_name: string; scopes: string[] };
    expect(info.client_name).toBe('某网页版助手');
    expect(info.scopes).toEqual(['case:read', 'case:write']);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM oauth_codes').get() as { c: number }).c,
      '只是看了一眼同意页就签出了授权码',
    ).toBe(0);

    // 同意 → 授权码；state 原样回传
    const approved = await consent(query);
    expect(approved.status).toBe(200);
    const target = new URL(approved.body.redirect_to);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('state')).toBe('st-123');

    // 换令牌
    const tok = await postToken({
      grant_type: 'authorization_code',
      code: codeOf(approved.body.redirect_to),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe('Bearer');
    expect(Number(tok.body.expires_in)).toBe(3600);
    expect(tok.body.scope).toBe('case:read case:write');

    // 用 access token 调 MCP
    const listed = await toolsList(tok.body.access_token);
    expect(listed.status).toBe(200);
    expect(
      ((listed.body.result as { tools: unknown[] }).tools ?? []).length,
      'OAuth 令牌调 tools/list 拿不到工具清单',
    ).toBeGreaterThan(0);

    // 续期：新令牌可用
    const refreshed = await postToken({
      grant_type: 'refresh_token',
      refresh_token: tok.body.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect((await toolsList(refreshed.body.access_token)).status).toBe(200);

    // 交还 → 整条链停，再调即 401
    const revoked = await revokePost(
      new Request('http://localhost/api/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshed.body.refresh_token }).toString(),
      }),
    );
    expect(revoked.status).toBe(200);
    expect((await toolsList(refreshed.body.access_token)).status).toBe(401);
  });

  test('设置页看得见这条授权，且写着它来自哪个客户端', async () => {
    await fullGrant();
    const res = await keysGet(
      new Request('http://localhost/api/v1/keys', {
        headers: { authorization: `Bearer ${jwtA}` },
      }),
    );
    const body = (await res.json()) as {
      keys: { name: string; source: string; client_name: string | null; viewable: boolean }[];
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].source).toBe('oauth');
    expect(body.keys[0].client_name).toBe('某网页版助手');
    // 没有明文可看：它不是一把钥匙，是一次授权
    expect(body.keys[0].viewable).toBe(false);
  });
});

describe('PKCE', () => {
  test('缺 code_challenge → 授权请求当场被拒（GET 与 POST 都拒）', async () => {
    const clientId = await registerClient();
    const query = authorizeQuery({ client_id: clientId }); // 没有 code_challenge
    const res = await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');

    // 页面绕不过去：直接 POST 同样拒
    const approved = await consent(query);
    expect(approved.status).toBe(400);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM oauth_codes').get() as { c: number }).c,
      '缺 PKCE 也签出了授权码',
    ).toBe(0);
  });

  test('code_challenge_method=plain 不接受', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = authorizeQuery({
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: 'plain',
    });
    const res = await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`));
    expect(res.status).toBe(400);
  });

  test('verifier 不对 → 换不出令牌', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = authorizeQuery({ client_id: clientId, code_challenge: challenge });
    const approved = await consent(query);
    const tok = await postToken({
      grant_type: 'authorization_code',
      code: codeOf(approved.body.redirect_to),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier, // 另一次流程的 verifier
    });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
    expect(
      (db.prepare('SELECT COUNT(*) c FROM oauth_tokens').get() as { c: number }).c,
      'PKCE 没过却签出了令牌',
    ).toBe(0);
  });

  test('verifier 短于 43 字符不算数（challenge 由它算出也不行）', async () => {
    const clientId = await registerClient();
    const short = 'abc';
    const challenge = crypto.createHash('sha256').update(short, 'ascii').digest('base64url');
    const query = authorizeQuery({ client_id: clientId, code_challenge: challenge });
    const approved = await consent(query);
    const tok = await postToken({
      grant_type: 'authorization_code',
      code: codeOf(approved.body.redirect_to),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: short,
    });
    expect(tok.status).toBe(400);
  });
});

describe('授权码', () => {
  test('二次使用被拒，并把它此前签出的令牌一并吊销', async () => {
    const g = await fullGrant();
    // 第一次换出来的 access 此刻是好用的
    expect((await toolsList(g.access)).status).toBe(200);

    const again = await postToken({
      grant_type: 'authorization_code',
      code: g.code,
      client_id: g.clientId,
      redirect_uri: REDIRECT,
      code_verifier: g.verifier,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    // 重放说明码泄漏过 → 这条链上的令牌全停
    expect((await toolsList(g.access)).status).toBe(401);
    expect(
      (
        db.prepare('SELECT COUNT(*) c FROM oauth_tokens WHERE revoked_at IS NULL').get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  test('过期的码换不出令牌', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const approved = await consent(authorizeQuery({ client_id: clientId, code_challenge: challenge }));
    db.prepare("UPDATE oauth_codes SET expires_at = '2020-01-01 00:00:00'").run();
    const tok = await postToken({
      grant_type: 'authorization_code',
      code: codeOf(approved.body.redirect_to),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
  });

  test('换令牌时的 redirect_uri 与发起时不一致 → 拒', async () => {
    const clientId = await registerClient([REDIRECT, 'https://client.example.com/other']);
    const { verifier, challenge } = pkce();
    const approved = await consent(authorizeQuery({ client_id: clientId, code_challenge: challenge }));
    const tok = await postToken({
      grant_type: 'authorization_code',
      code: codeOf(approved.body.redirect_to),
      client_id: clientId,
      // 白名单里确实有这个地址，但不是这次授权用的那个
      redirect_uri: 'https://client.example.com/other',
      code_verifier: verifier,
    });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
  });
});

describe('redirect_uri 白名单', () => {
  test('不在白名单里的地址 → 授权请求被拒', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = authorizeQuery({
      client_id: clientId,
      code_challenge: challenge,
      redirect_uri: 'https://evil.example.com/cb',
    });
    expect((await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`))).status).toBe(400);
    expect((await consent(query)).status).toBe(400);
  });

  test('【前缀不算命中】登记地址加一段尾巴、加一个查询参数都不认', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    for (const candidate of [
      `${REDIRECT}.evil.example.com/`,
      `${REDIRECT}?next=//evil.example.com`,
      `${REDIRECT}/`,
      `${REDIRECT}extra`,
    ]) {
      const query = authorizeQuery({
        client_id: clientId,
        code_challenge: challenge,
        redirect_uri: candidate,
      });
      const res = await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`));
      expect(res.status, `${candidate} 被当成了登记过的地址`).toBe(400);
    }
  });

  test('注册时就拒掉明文 http 与非本机地址', async () => {
    const res = await registerPost(
      new Request('http://localhost/api/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example.com/cb'] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  test('本机回调（http://localhost）照收——本机客户端没有证书', async () => {
    const clientId = await registerClient(['http://localhost:7777/cb']);
    expect(clientId).toMatch(/^oc_/);
  });

  test('没注册过的 client_id → 401 invalid_client', async () => {
    const { challenge } = pkce();
    const query = authorizeQuery({ client_id: 'oc_nobody', code_challenge: challenge });
    const res = await authorizeGet(new Request(`http://localhost/api/oauth/authorize?${query}`));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });
});

describe('refresh 旋转', () => {
  test('续期一次，旧 refresh 当场作废（旋转），旧 access 也停', async () => {
    const g = await fullGrant();
    const refreshed = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token, '续期没有换新的 refresh').not.toBe(g.refresh);
    expect(refreshed.body.access_token).not.toBe(g.access);
    // 旋转 = 旧的当场不能用；不作废旧 access 的形态是被截走的那条还能再用满一小时
    expect((await toolsList(g.access)).status).toBe(401);
    expect((await toolsList(refreshed.body.access_token)).status).toBe(200);
  });

  test('复用旧 refresh → 拒，且整条链吊销（连刚发的新令牌一起停）', async () => {
    const g = await fullGrant();
    const refreshed = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect((await toolsList(refreshed.body.access_token)).status).toBe(200);

    const replay = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    // 复用说明凭据泄漏 → 现役那条也停，逼一次重新授权
    expect((await toolsList(refreshed.body.access_token)).status).toBe(401);
  });

  test('access token 当 refresh 用 → 拒', async () => {
    const g = await fullGrant();
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.access,
      client_id: g.clientId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('过期的 refresh 换不出令牌', async () => {
    const g = await fullGrant();
    db.prepare("UPDATE oauth_tokens SET expires_at = '2020-01-01 00:00:00' WHERE kind = 'refresh'").run();
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(res.status).toBe(400);
  });
});

describe('与 api key 等价', () => {
  test('设置页吊销那一行 ⇒ access token 立刻 401，refresh 也换不出新的', async () => {
    const g = await fullGrant();
    expect((await toolsList(g.access)).status).toBe(200);

    db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(g.keyId);

    expect((await toolsList(g.access)).status).toBe(401);
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(res.status).toBe(400);
  });

  test('【红线】OAuth 令牌照样看不见别人的案件 —— 与 api key 同一个判据', async () => {
    // 授权给乙，再拿这串令牌去读甲的案件
    jwtA = signToken(userB);
    const g = await fullGrant();
    const res = await mcpPost(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${g.access}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'case_get', arguments: { case_id: caseA } },
        }),
      }),
    );
    const body = (await res.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error_code).toBe('CASE_NOT_FOUND');
    expect(body.result.content[0].text).not.toContain('甲的档案');
  });

  test('OAuth 令牌不能拿来管理密钥（不能用令牌换新授权，也不能列 key）', async () => {
    const g = await fullGrant();
    const res = await keysGet(
      new Request('http://localhost/api/v1/keys', {
        headers: { authorization: `Bearer ${g.access}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('WEB_SESSION_REQUIRED');
  });

  test('没登录态就点同意 → 401，一个授权码也签不出来', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await consent(
      authorizeQuery({ client_id: clientId, code_challenge: challenge }),
      null,
    );
    expect(res.status).toBe(401);
    expect((db.prepare('SELECT COUNT(*) c FROM oauth_codes').get() as { c: number }).c).toBe(0);
  });
});

describe('整链吊销连带停用 api_keys（设置页据此显示已失效）', () => {
  /** 设置页读 key 列表用的正是这条（网页登录态）；返回某把 key 在页面上的 enabled */
  async function keyEnabledInSettings(keyId: number): Promise<boolean | undefined> {
    const res = await keysGet(
      new Request('http://localhost/api/v1/keys', {
        headers: { authorization: `Bearer ${jwtA}` },
      }),
    );
    const body = (await res.json()) as { keys: { id: number; enabled: boolean }[] };
    return body.keys.find((k) => k.id === keyId)?.enabled;
  }
  const enabledInDb = (keyId: number) =>
    (db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(keyId) as { enabled: number })
      .enabled;

  test('授权码复用 ⇒ 对应 api_keys.enabled=0，设置页那一行标已失效', async () => {
    const g = await fullGrant();
    expect(enabledInDb(g.keyId)).toBe(1);
    expect(await keyEnabledInSettings(g.keyId)).toBe(true);

    const again = await postToken({
      grant_type: 'authorization_code',
      code: g.code,
      client_id: g.clientId,
      redirect_uri: REDIRECT,
      code_verifier: g.verifier,
    });
    expect(again.status).toBe(400);

    // 判据：整链吊销的同时，映射的 api_keys 行停用，设置页据 enabled 显示「已失效」
    expect(enabledInDb(g.keyId)).toBe(0);
    expect(await keyEnabledInSettings(g.keyId)).toBe(false);
  });

  test('refresh 复用 ⇒ 对应 api_keys.enabled=0，设置页那一行标已失效', async () => {
    const g = await fullGrant();
    // 先正常续期一次（旋转，不吊销）：旧 refresh 作废，key 仍启用
    await postToken({ grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.clientId });
    expect(enabledInDb(g.keyId)).toBe(1);

    // 复用作废了的旧 refresh ⇒ 整链吊销 ⇒ key 一并停用
    const replay = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(replay.status).toBe(400);

    expect(enabledInDb(g.keyId)).toBe(0);
    expect(await keyEnabledInSettings(g.keyId)).toBe(false);
  });

  test('正常旋转（续期）不停用 key —— 只有 revokeChain 连带，revokeChainKind 不连带', async () => {
    const g = await fullGrant();
    const refreshed = await postToken({
      grant_type: 'refresh_token',
      refresh_token: g.refresh,
      client_id: g.clientId,
    });
    expect(refreshed.status).toBe(200);
    // 续期是旋转不是吊销：key 必须仍启用，否则新令牌下一次调用就被 key.enabled 挡掉
    expect(enabledInDb(g.keyId)).toBe(1);
    expect((await toolsList(refreshed.body.access_token)).status).toBe(200);
  });
});

describe('交还令牌', () => {
  test('认不出的令牌也回 200 —— 这个口不能当令牌探测器用', async () => {
    const res = await revokePost(
      new Request('http://localhost/api/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
      }),
    );
    expect(res.status).toBe(200);
  });
});
