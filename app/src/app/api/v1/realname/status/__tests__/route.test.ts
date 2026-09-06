// GET /api/v1/realname/status 的双态判据。
//
// 【这条端点为什么要对 api key 开】未实名时证据登记、上传地址、固化出证一律 403 REALNAME_REQUIRED。
// 此前它只认网页登录态，agent 读不到自己账号的实名状态，只能**发一次会失败的写入**去试探——
// 试探本身有副作用，而且失败之后它也说不清是没实名还是别的原因。
//
// 【这条端点为什么不能对 api key 全开】网页那条会去上游拉一次结果并回填 users，
// 回包里还带 verification_status / method / message。key 这条只回三态：
// 姓名、证件号、上游流水都不该从一把长期凭据后面漏出去。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

let GET: (req: Request) => Promise<Response>;
let db: Database;

function issueKey(userId: number, scopes: string[] = ['case:read', 'case:write']): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

function makeUser(authStatus: string): number {
  return Number(
    db
      .prepare("INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, ?, '2026-09-01T00:00:00.000Z')")
      .run(`u-${crypto.randomUUID()}`, authStatus).lastInsertRowid,
  );
}

function ask(token?: string): Promise<Response> {
  return GET(
    new Request('http://localhost/api/v1/realname/status', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-realname-${crypto.randomUUID()}.db`);

  GET = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM users').run();
});

describe('api key：三态只读', () => {
  test.each(['已实名', '待审', '未认证'])('auth_status=%s 原样回给 key', async (status) => {
    const uid = makeUser(status);
    const res = await ask(issueKey(uid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, auth_status: status });
  });

  test('回包里没有姓名 / 证件 / 上游流水这些字段（多一个字段就是多一条泄漏面）', async () => {
    const uid = makeUser('已实名');
    db.prepare("UPDATE users SET real_name_enc = 'ENC-姓名', id_card_enc = 'ENC-证件' WHERE id = ?").run(uid);
    const body = await (await ask(issueKey(uid))).json();
    expect(Object.keys(body).sort()).toEqual(['auth_status', 'ok']);
    expect(JSON.stringify(body)).not.toContain('ENC-');
  });

  test('只有 case:write 的 key 也读得到（要它的恰恰是写之前先看闸门那种 key）', async () => {
    const uid = makeUser('待审');
    const res = await ask(issueKey(uid, ['case:write']));
    expect(res.status).toBe(200);
    expect((await res.json()).auth_status).toBe('待审');
  });

  test('没带凭据 → 401 UNAUTHORIZED', async () => {
    const res = await ask();
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('UNAUTHORIZED');
  });

  test('吊销的 key 立刻读不到（enabled=0 与没带凭据同档）', async () => {
    const uid = makeUser('已实名');
    const key = issueKey(uid);
    db.prepare('UPDATE api_keys SET enabled = 0').run();
    expect((await ask(key)).status).toBe(401);
  });
});

describe('网页会话：回包不变', () => {
  test('jwt 那条仍然带 verification_status / method / message（没被 key 那条挤掉）', async () => {
    const uid = makeUser('已实名');
    const body = await (await ask(signToken(uid))).json();
    expect(body.ok).toBe(true);
    expect(body.auth_status).toBe('已实名');
    // 落定后不再打上游，直接回存量结论——字段一个不少
    for (const key of ['verification_status', 'method', 'message']) {
      expect(Object.keys(body), `网页回包少了 ${key}`).toContain(key);
    }
  });
});
