// app/src/app/api/v1/keys/__tests__/route.test.ts
// key 管理面。三条要害：
//   ① 列表面永不回显 hash 或密文；
//   ② api key 不能自我增殖（拿 key 再造 key），也不能拿去查看/轮换任何密钥；
//   ③ 明文可以回看，但回看的必须是**当初那一串**，而且轮换之后旧的立刻作废。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request) => Promise<Response>;
type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let listKeys: Handler;
let createKey: Handler;
let revokeKey: IdHandler;
let readSecret: IdHandler;
let rotateKey: IdHandler;
let mcpPost: Handler;
let db: Database;
let userA: number;
let userB: number;

function req(method: string, body?: unknown, auth?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/keys', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-keys-${crypto.randomUUID()}.db`);

  const collection = await import('../route');
  listKeys = collection.GET;
  createKey = collection.POST;
  revokeKey = (await import('../[id]/route')).DELETE;
  readSecret = (await import('../[id]/secret/route')).GET;
  rotateKey = (await import('../[id]/rotate/route')).POST;
  // MCP 握手：client_name 是从那条链路落库的，测「响应里的名字对不对」就得让它真的握一次手
  mcpPost = (await import('../../../mcp/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM users').run();
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
});

describe('创建', () => {
  test('返回明文 key 一次，库里只有 SHA256', async () => {
    const res = await createKey(req('POST', { name: '我的 Claude' }, signToken(userA)));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.scopes).toEqual(['case:read', 'case:write']);

    const row = db.prepare('SELECT key_hash, scopes, name FROM api_keys').get() as {
      key_hash: string;
      scopes: string;
      name: string;
    };
    expect(row.key_hash).toBe(hashApiKey(body.key));
    // 明文绝不落库
    expect(row.key_hash).not.toBe(body.key);
    expect(JSON.stringify(row)).not.toContain(body.key);
    expect(JSON.parse(row.scopes)).toEqual(['case:read', 'case:write']);
  });

  test('可以显式收紧 scopes；含未知项则拒绝创建', async () => {
    const narrow = await createKey(req('POST', { name: '只读', scopes: ['case:read'] }, signToken(userA)));
    expect((await narrow.json()).scopes).toEqual(['case:read']);

    const bad = await createKey(req('POST', { name: 'x', scopes: ['admin'] }, signToken(userA)));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe('INVALID_SCOPES');
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 1 });
  });

  test('name 不能为空', async () => {
    const res = await createKey(req('POST', { name: '   ' }, signToken(userA)));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_NAME');
  });

  test('【要害】不能拿 api key 再造 api key', async () => {
    const created = await createKey(req('POST', { name: '第一把' }, signToken(userA)));
    const key = (await created.json()).key;

    const res = await createKey(req('POST', { name: '想自我复制' }, key));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('WEB_SESSION_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 1 });
  });

  test('没登录 → 401', async () => {
    expect((await createKey(req('POST', { name: 'x' }))).status).toBe(401);
  });
});

describe('列出', () => {
  test('只列自己的，且永不回显 key 明文或 hash', async () => {
    await createKey(req('POST', { name: '甲的' }, signToken(userA)));
    await createKey(req('POST', { name: '乙的' }, signToken(userB)));

    const res = await listKeys(req('GET', undefined, signToken(userA)));
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ name: '甲的', enabled: true, scopes: ['case:read', 'case:write'] });
    expect(JSON.stringify(body)).not.toContain('key_hash');
    expect(body.keys[0].key).toBeUndefined();
  });

  /**
   * MCP 自报名整条链：initialize 的 clientInfo.name → api_keys.client_name → GET /keys 响应
   * → 页面上的「已接入：claude-code」。
   *
   * 【为什么必须在接口层测】lib/db 那边只钉了「列有没有落进去」，api/mcp 那边只钉了
   * 「握手写没写这一列」。把 listApiKeys 的 SELECT 里 client_name 三个字删掉，
   * 那两处照样全绿：响应里这个字段变成 undefined → 前端 `nameIsKeyName` 恒真 →
   * 页面从此永远念用户自己给钥匙起的名，并附一句「你的客户端没报自己的名字」。
   * **对面明明报了名字，我们却当着用户的面说它没报**——而没有任何报错。
   */
  test('MCP 自报的名字要出现在响应里，且与握手写进去的那个字一致', async () => {
    const created = await createKey(req('POST', { name: '我的 Claude' }, signToken(userA)));
    const { key } = await created.json();

    // 正对照：握手之前这一列是空的，下面那条断言才不是恒真
    const before = await (await listKeys(req('GET', undefined, signToken(userA)))).json();
    expect(before.keys[0]).toHaveProperty('client_name');
    expect(before.keys[0].client_name).toBeNull();

    const handshake = await mcpPost(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } },
        }),
      }),
    );
    expect(handshake.status).toBe(200);

    const after = await (await listKeys(req('GET', undefined, signToken(userA)))).json();
    const stored = db.prepare('SELECT client_name FROM api_keys').get() as {
      client_name: string | null;
    };
    expect(stored.client_name).toBe('claude-code'); // 握手确实写了
    expect(after.keys[0].client_name).toBe('claude-code'); // 响应确实带出来了
    expect(after.keys[0].client_name).toBe(stored.client_name); // 且是同一个字，不是巧合
  });
});

describe('吊销', () => {
  test('吊销后 enabled=0，行还在（保住审计线索与 hash 占位）', async () => {
    const created = await createKey(req('POST', { name: '要吊销的' }, signToken(userA)));
    const { id } = await created.json();

    const res = await revokeKey(req('DELETE', undefined, signToken(userA)), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(id)).toEqual({ enabled: 0 });
  });

  test('【红线】吊销不了别人的 key，且报错与"不存在"一致', async () => {
    const created = await createKey(req('POST', { name: '甲的' }, signToken(userA)));
    const { id } = await created.json();

    const byB = await revokeKey(req('DELETE', undefined, signToken(userB)), {
      params: Promise.resolve({ id: String(id) }),
    });
    const missing = await revokeKey(req('DELETE', undefined, signToken(userB)), {
      params: Promise.resolve({ id: '999999' }),
    });
    expect(byB.status).toBe(404);
    expect(await byB.json()).toEqual(await missing.json());
    // 甲的 key 完好
    expect(db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(id)).toEqual({ enabled: 1 });
  });

  test('吊销后这把 key 立刻不能用了', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id, key } = await created.json();
    const { resolveIdentity } = await import('@/lib/auth/identity');

    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${key}` }))).not.toBeNull();
    await revokeKey(req('DELETE', undefined, signToken(userA)), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${key}` }))).toBeNull();
  });

  test('伪造的 key 不因为存在同名用户就放行', async () => {
    const { resolveIdentity } = await import('@/lib/auth/identity');
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${generateApiKey()}` }))).toBeNull();
  });
});

/* ── 明文可回看 / 轮换 ───────────────────────────────────── */

/** 这两条路由的入参形状一样，包一层免得每个用例都写一遍 Promise.resolve */
function withId(handler: IdHandler, id: number | string, auth?: string, method = 'GET') {
  return handler(req(method, undefined, auth), { params: Promise.resolve({ id: String(id) }) });
}

describe('查看明文', () => {
  test('拿回来的就是创建时那一串（不是 hash、不是别的东西）', async () => {
    const created = await createKey(req('POST', { name: '我的 Claude' }, signToken(userA)));
    const { id, key } = await created.json();

    const res = await withId(readSecret, id, signToken(userA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, id, name: '我的 Claude' });
    expect(body.key).toBe(key);
    // 正对照：库里存的密文既不是明文也不是 hash，是真的加过密的
    const row = db.prepare('SELECT key_hash, secret_enc FROM api_keys WHERE id = ?').get(id) as {
      key_hash: string;
      secret_enc: string;
    };
    expect(row.secret_enc).not.toBe(key);
    expect(row.secret_enc).not.toBe(row.key_hash);
    expect(row.secret_enc.startsWith('v1:')).toBe(true);
  });

  test('查看不算「接进来过」——绝不碰 last_used_at', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id } = await created.json();
    await withId(readSecret, id, signToken(userA));
    // 碰了这一列，页面会在用户一个字都还没粘进客户端时就说「已接入」
    expect(db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id)).toEqual({
      last_used_at: null,
    });
  });

  test('存量旧密钥（没有密文）→ 409 KEY_NOT_VIEWABLE，指路去轮换', async () => {
    const created = await createKey(req('POST', { name: '假装是老的' }, signToken(userA)));
    const { id } = await created.json();
    db.prepare('UPDATE api_keys SET secret_enc = NULL WHERE id = ?').run(id);

    const res = await withId(readSecret, id, signToken(userA));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe('KEY_NOT_VIEWABLE');
    expect(body.message).toContain('轮换');
  });

  test('密文解不开（主密钥换过）→ 500 SECRET_DECRYPT_FAILED，不吐内部异常', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id } = await created.json();
    // 换一把主密钥重新加密的密文，等价于"这条密文对不上现在这把钥匙"
    db.prepare('UPDATE api_keys SET secret_enc = ? WHERE id = ?').run('v1:bm90LWEtcmVhbC1jaXBoZXI=', id);

    const res = await withId(readSecret, id, signToken(userA));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error_code).toBe('SECRET_DECRYPT_FAILED');
    // 自述三段式，且不把服务端的环境变量名/异常原文端出去
    for (const part of ['缺什么', '为什么缺', '怎么办']) expect(body.message).toContain(part);
    expect(body.message).not.toContain('LAWER_DATA_KEY');
  });

  test('【红线】api key 身份看不了明文（连自己那把也不行）', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id, key } = await created.json();
    const res = await withId(readSecret, id, key);
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('WEB_SESSION_REQUIRED');
  });

  test('【红线】看不了别人的 key，且报错与「不存在」一字不差', async () => {
    const created = await createKey(req('POST', { name: '甲的' }, signToken(userA)));
    const { id } = await created.json();

    const byB = await withId(readSecret, id, signToken(userB));
    const missing = await withId(readSecret, 999999, signToken(userB));
    expect(byB.status).toBe(404);
    expect(await byB.json()).toEqual(await missing.json());
  });
});

describe('轮换', () => {
  test('换发新明文，旧明文立刻作废', async () => {
    const created = await createKey(req('POST', { name: '我的 Claude' }, signToken(userA)));
    const { id, key: oldKey } = await created.json();
    const { resolveIdentity } = await import('@/lib/auth/identity');
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${oldKey}` }))).not.toBeNull();

    const res = await withId(rotateKey, id, signToken(userA), 'POST');
    expect(res.status).toBe(200);
    const { key: newKey } = await res.json();
    expect(newKey).not.toBe(oldKey);

    // 旧的当场不认，新的能用
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${oldKey}` }))).toBeNull();
    expect(resolveIdentity(db, new Headers({ authorization: `Bearer ${newKey}` }))).not.toBeNull();
  });

  test('新明文也能立刻回看', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id } = await created.json();
    const { key: newKey } = await (await withId(rotateKey, id, signToken(userA), 'POST')).json();
    expect((await (await withId(readSecret, id, signToken(userA))).json()).key).toBe(newKey);
  });

  test('id / name / scopes / client_name 一个都不变，rotated_at 落痕', async () => {
    const created = await createKey(
      req('POST', { name: '我的 Claude', scopes: ['case:read'] }, signToken(userA)),
    );
    const { id } = await created.json();
    db.prepare("UPDATE api_keys SET client_name = 'claude-code' WHERE id = ?").run(id);

    const body = await (await withId(rotateKey, id, signToken(userA), 'POST')).json();
    expect(body).toMatchObject({
      ok: true,
      id, // 不是新建一行：新建会换 id，前端本地缓存的那一行当场对不上
      name: '我的 Claude',
      scopes: ['case:read'],
      client_name: 'claude-code',
    });
    const row = db
      .prepare('SELECT name, scopes, client_name, rotated_at FROM api_keys WHERE id = ?')
      .get(id) as { name: string; scopes: string; client_name: string; rotated_at: string };
    expect(row).toMatchObject({ name: '我的 Claude', client_name: 'claude-code' });
    expect(JSON.parse(row.scopes)).toEqual(['case:read']);
    expect(row.rotated_at).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 1 });
  });

  test('【要害】轮换把 last_used_at 清零——旧那把已作废，「已接入」不该继续挂着', async () => {
    const created = await createKey(req('POST', { name: 'x' }, signToken(userA)));
    const { id, key } = await created.json();
    const { resolveIdentity } = await import('@/lib/auth/identity');
    resolveIdentity(db, new Headers({ authorization: `Bearer ${key}` })); // 用一次，落 last_used_at
    expect(
      (db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as { last_used_at: string })
        .last_used_at,
    ).toBeTruthy();

    await withId(rotateKey, id, signToken(userA), 'POST');
    expect(db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id)).toEqual({
      last_used_at: null,
    });
  });

  test('【红线】api key 身份轮换不了，别人的 key 也轮换不了', async () => {
    const created = await createKey(req('POST', { name: '甲的' }, signToken(userA)));
    const { id, key } = await created.json();

    const byKey = await withId(rotateKey, id, key, 'POST');
    expect(byKey.status).toBe(403);
    expect((await byKey.json()).error_code).toBe('WEB_SESSION_REQUIRED');

    const byB = await withId(rotateKey, id, signToken(userB), 'POST');
    expect(byB.status).toBe(404);
    // 甲那把纹丝不动：明文还是原来那串
    expect((await (await withId(readSecret, id, signToken(userA))).json()).key).toBe(key);
  });
});

describe('列表面', () => {
  test('回「能不能查看」这一位，但不回密文本身', async () => {
    const created = await createKey(req('POST', { name: '新的' }, signToken(userA)));
    const { id } = await created.json();
    const fresh = await (await listKeys(req('GET', undefined, signToken(userA)))).json();
    expect(fresh.keys[0].viewable).toBe(true);
    const row = db.prepare('SELECT secret_enc FROM api_keys WHERE id = ?').get(id) as {
      secret_enc: string;
    };
    expect(JSON.stringify(fresh)).not.toContain(row.secret_enc);

    db.prepare('UPDATE api_keys SET secret_enc = NULL WHERE id = ?').run(id);
    const old = await (await listKeys(req('GET', undefined, signToken(userA)))).json();
    expect(old.keys[0].viewable).toBe(false);
  });
});
