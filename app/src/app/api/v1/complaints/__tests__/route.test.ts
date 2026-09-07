// app/src/app/api/v1/complaints/__tests__/route.test.ts
// 投诉 / 举报 / 个人信息权利请求的提交端点。
//
// 【这一条端点的两条底线】
// ① **只认网页登录态**：这条路上做的是本人的法律行为，一条「请删除我的个人信息」
//    要在 15 个工作日内办结。让 api key 也能提的形态是：用户接进来的某个助手
//    替他提了一条权利请求，钟已经在走、答复会寄到那条记录里留的联系方式上，
//    而本人不知道有这回事。
// ② **受理编号由服务端生成**：让前端传的形态是两个人拿着同一串来问，
//    而我们答不出该翻哪一条。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

let POST: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;

const BODY = { kind: '举报', body: '这条回复里编了一个不存在的案号。', contact: 'me@example.com' };

function post(auth: string | undefined, body: unknown = BODY): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/complaints', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-complaints-${crypto.randomUUID()}.db`);
  ({ POST, GET } = await import('../route'));
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM complaints; DELETE FROM api_keys; DELETE FROM users;');
});

function seedUser(): number {
  return Number(db.prepare("INSERT INTO users (phone_hash) VALUES ('h-a')").run().lastInsertRowid);
}

describe('POST /api/v1/complaints', () => {
  test('无凭据 → 401，且什么都没落库', async () => {
    expect((await POST(post(undefined))).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) n FROM complaints').get()).toEqual({ n: 0 });
  });

  test('登录态提交 → 201，回一串受理编号（变异：把编号改成前端传的 → 红）', async () => {
    const uid = seedUser();
    const res = await POST(post(signToken(uid)));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { complaint: { receipt_no: string; kind: string } };
    expect(json.complaint.receipt_no).toMatch(/^TB-\d{8}-[23456789A-Z]{6}$/);
    expect(json.complaint.kind).toBe('举报');
    const row = db.prepare('SELECT receipt_no, user_id FROM complaints').get() as {
      receipt_no: string;
      user_id: number;
    };
    expect(row.receipt_no).toBe(json.complaint.receipt_no);
    expect(row.user_id).toBe(uid);
  });

  test('前端塞 receipt_no 也没用：编号仍由服务端生成', async () => {
    const uid = seedUser();
    const res = await POST(post(signToken(uid), { ...BODY, receipt_no: 'TB-19700101-AAAAAA' }));
    const json = (await res.json()) as { complaint: { receipt_no: string } };
    expect(json.complaint.receipt_no).not.toBe('TB-19700101-AAAAAA');
  });

  test('类型不在三类里 → 400，回话里列出三类，且不落库', async () => {
    const uid = seedUser();
    const res = await POST(post(signToken(uid), { ...BODY, kind: '反馈' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error_code: string; message: string };
    expect(json.error_code).toBe('BAD_COMPLAINT_KIND');
    expect(json.message).toContain('个人信息权利请求');
    expect(db.prepare('SELECT COUNT(*) n FROM complaints').get()).toEqual({ n: 0 });
  });

  test('请求体不是 JSON → 400', async () => {
    const uid = seedUser();
    const res = await POST(
      new Request('http://localhost/api/v1/complaints', {
        method: 'POST',
        headers: { authorization: `Bearer ${signToken(uid)}` },
        body: '不是 JSON',
      }),
    );
    expect(res.status).toBe(400);
  });

  /**
   * 【为什么 api key 要被挡在外面】见文件头 ①。
   * 【变异臂】把路由里的 requireWebSession 换成 requireIdentity ⇒ 这条红。
   */
  test('api key 提不了（403 WEB_SESSION_REQUIRED），只有网页登录态能提', async () => {
    const uid = seedUser();
    const { generateApiKey, hashApiKey } = await import('@/lib/auth/api-key');
    const { insertApiKey } = await import('@/lib/db/api-keys');
    const { encryptField } = await import('@/lib/crypto');
    const key = generateApiKey();
    insertApiKey(db, {
      userId: uid,
      name: 'k',
      keyHash: hashApiKey(key),
      scopesJson: JSON.stringify(['case:read', 'case:write']),
      secretEnc: encryptField(key),
    });
    const res = await POST(post(key));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('WEB_SESSION_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) n FROM complaints').get()).toEqual({ n: 0 });
  });
});

describe('GET /api/v1/complaints', () => {
  test('只回自己提的那几条（变异：把 uid 过滤去掉 → 红）', async () => {
    const a = seedUser();
    const b = Number(
      db.prepare("INSERT INTO users (phone_hash) VALUES ('h-b')").run().lastInsertRowid,
    );
    await POST(post(signToken(a)));
    await POST(post(signToken(b)));

    const res = await GET(
      new Request('http://localhost/api/v1/complaints', {
        headers: { authorization: `Bearer ${signToken(a)}` },
      }),
    );
    const json = (await res.json()) as { complaints: { receipt_no: string }[] };
    expect(json.complaints).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) n FROM complaints').get()).toEqual({ n: 2 });
  });

  test('没提过 → 空数组，不是 404', async () => {
    const uid = seedUser();
    const res = await GET(
      new Request('http://localhost/api/v1/complaints', {
        headers: { authorization: `Bearer ${signToken(uid)}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { complaints: unknown[] }).complaints).toEqual([]);
  });
});
