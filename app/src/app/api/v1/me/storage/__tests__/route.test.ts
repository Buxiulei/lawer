// app/src/app/api/v1/me/storage/__tests__/route.test.ts
// 本人存储用量端点。守两条底线：
// ① **只看得到自己**：uid 只来自 token，任何入参都不得改写它——这一页读的是
//    「谁上传了多少材料」，越权读到的是别人有没有在维权、材料有多厚，属案情泄露；
// ② 没用量返回零行、**不返回 404 也不编数**（见 /api/v1/me 的同款理由）。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

let GET: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;

function req(auth?: string, qs = ''): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://localhost/api/v1/me/storage${qs}`, { headers });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-storage-${crypto.randomUUID()}.db`);
  GET = (await import('../route')).GET;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec(
    'DELETE FROM messages; DELETE FROM threads; DELETE FROM evidence; DELETE FROM files; ' +
      'DELETE FROM cases; DELETE FROM users;',
  );
});

/** 建一个有 sizeBytes 材料 + 一条中文消息的用户，返回 uid。 */
function makeUserWithUsage(email: string, sha: string, sizeBytes: number): number {
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '朝阳案件').lastInsertRowid,
  );
  const fileId = Number(
    db.prepare('INSERT INTO files (sha256, size, enc_path) VALUES (?,?,?)')
      .run(sha, sizeBytes, `${sha}.enc`).lastInsertRowid,
  );
  db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
    .run(caseId, uid, fileId, '劳动合同');
  const th = Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid,
  );
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?,?,?)')
    .run(th, 'user', '解除通知书'); // 15 字节
  return uid;
}

describe('鉴权', () => {
  test('无 token → 401', async () => {
    expect((await GET(req())).status).toBe(401);
  });
});

describe('🔴 只看得到自己的用量', () => {
  test('甲乙各拿自己的数，互不串台', async () => {
    const a = makeUserWithUsage('a@t.com', 'aaa', 111);
    const b = makeUserWithUsage('b@t.com', 'bbb', 222);

    const ra = await (await GET(req(signToken(a)))).json();
    const rb = await (await GET(req(signToken(b)))).json();

    expect(ra.storage).toMatchObject({ user_id: a, file_bytes: 111, message_bytes: 15 });
    expect(rb.storage).toMatchObject({ user_id: b, file_bytes: 222, message_bytes: 15 });
  });

  test('入参不得改写身份：带 ?user_id=乙 仍然只返回甲', async () => {
    const a = makeUserWithUsage('a@t.com', 'aaa', 111);
    const b = makeUserWithUsage('b@t.com', 'bbb', 222);

    for (const qs of [`?user_id=${b}`, `?uid=${b}`, `?user_id=${b}&limit=1`]) {
      const body = await (await GET(req(signToken(a), qs))).json();
      expect(body.storage.user_id).toBe(a);
      expect(body.storage.file_bytes).toBe(111); // 拿到 222 即越权
    }
  });

  test('响应体里不出现别人的 user_id', async () => {
    const a = makeUserWithUsage('a@t.com', 'aaa', 111);
    const b = makeUserWithUsage('b@t.com', 'bbb', 222);
    const raw = await (await GET(req(signToken(a)))).text();
    expect(raw).not.toContain(`"user_id":${b}`);
    expect(JSON.parse(raw).storage.user_id).toBe(a);
  });
});

describe('零用量', () => {
  test('新注册、什么都没传的用户拿到零行而不是 404', async () => {
    const uid = Number(
      db.prepare('INSERT INTO users (email) VALUES (?)').run('idle@t.com').lastInsertRowid,
    );
    const res = await GET(req(signToken(uid)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      storage: {
        user_id: uid,
        file_count: 0,
        file_bytes: 0,
        evidence_count: 0,
        message_count: 0,
        message_bytes: 0,
        total_bytes: 0,
      },
    });
  });
});

describe('口径与 lib 一致', () => {
  test('端点返回的就是 getUserStorage 的那一行', async () => {
    const a = makeUserWithUsage('a@t.com', 'aaa', 111);
    const { getUserStorage } = await import('@/lib/db/storageAudit');
    const body = await (await GET(req(signToken(a)))).json();
    expect(body.storage).toEqual(getUserStorage(db, a));
  });
});
