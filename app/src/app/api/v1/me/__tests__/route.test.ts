// app/src/app/api/v1/me/__tests__/route.test.ts
// 「我的」页那行昵称/手机号此前读的是 _mock/demo 的 demoUser。这里守两条底线：
// ① 响应里**绝不出现完整手机号**（掩码必须在服务端做完）；
// ② 没有的东西返回 null，**不编默认值顶上**——编一个页面就"看起来正常了"，
//    而那正是 P0-2 的病灶形态（假数据渲染得比真数据还完整）。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { encryptField } from '@/lib/crypto';

let GET: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;

const PHONE = '13800001111';

function req(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/me', { headers });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-me-${crypto.randomUUID()}.db`);
  GET = (await import('../route')).GET;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM memberships; DELETE FROM users;');
});

function makeUser(opts: { phone?: string; email?: string; auth?: string } = {}): number {
  return Number(
    db
      .prepare('INSERT INTO users (phone_enc, email, auth_status) VALUES (?,?,?)')
      .run(
        opts.phone ? encryptField(opts.phone) : null,
        opts.email ?? null,
        opts.auth ?? '未认证',
      ).lastInsertRowid,
  );
}

describe('鉴权', () => {
  test('无 token → 401', async () => {
    expect((await GET(req())).status).toBe(401);
  });

  test('只拿得到自己的：甲的 token 取到的是甲', async () => {
    const a = makeUser({ phone: PHONE, email: 'a@t.com' });
    const b = makeUser({ email: 'b@t.com' });
    const body = await (await GET(req(signToken(b)))).json();
    expect(body.email).toBe('b@t.com');
    expect(body.phone_masked).toBeNull(); // 乙没绑手机
    expect(a).not.toBe(b);
  });
});

describe('🔴 手机号不得以明文离开服务端', () => {
  test('响应体逐字节不含完整号', async () => {
    makeUser({ phone: PHONE });
    const uid = db.prepare('SELECT id FROM users').get() as { id: number };
    const res = await GET(req(signToken(uid.id)));
    const raw = await res.text();
    // 【断言的是原始响应文本，不是解析后的字段】前端若改成自己截，
    // 完整号仍会在这段文本里躺过一次——浏览器缓存、代理日志、devtools 全留痕。
    expect(raw).not.toContain(PHONE);
    const body = JSON.parse(raw);
    expect(body.phone_masked).toBeTruthy();
    expect(body.phone_masked).not.toBe(PHONE);
  });
});

describe('没有的东西返回 null，不编默认值', () => {
  test('未绑手机 → phone_masked 为 null，不是空串', async () => {
    const uid = makeUser({ email: 'x@t.com' });
    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.phone_masked).toBeNull();
    expect(body.phone_masked).not.toBe('');
  });

  test('无有效会员 → membership 为 null，不是「无」这类占位串', async () => {
    const uid = makeUser({ email: 'x@t.com' });
    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.membership).toBeNull();
  });

  test('有有效会员 → 如实给出 plan 与到期时间', async () => {
    const uid = makeUser({ email: 'x@t.com' });
    db.prepare(
      "INSERT INTO memberships (user_id, plan, expires_at) VALUES (?, 'standard', datetime('now','+30 days'))",
    ).run(uid);
    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.membership).toMatchObject({ plan: 'standard' });
    expect(typeof body.membership.expires_at).toBe('string');
  });

  test('过期会员不算有效（到期即消失，不留一个好看的旧徽标）', async () => {
    const uid = makeUser({ email: 'x@t.com' });
    db.prepare(
      "INSERT INTO memberships (user_id, plan, expires_at) VALUES (?, 'standard', datetime('now','-1 day'))",
    ).run(uid);
    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.membership).toBeNull();
  });

  test('响应里不含任何演示身份的痕迹', async () => {
    const uid = makeUser({ email: 'x@t.com' });
    const raw = await (await GET(req(signToken(uid)))).text();
    for (const demo of ['demoUser', '演示', 'demo', '土八鼠用户', '示例']) {
      expect(raw, demo).not.toContain(demo);
    }
  });
});

describe('auth_status 如实透传', () => {
  test('三种状态都原样出', async () => {
    for (const s of ['未认证', '待审', '已实名']) {
      db.exec('DELETE FROM users;');
      const uid = makeUser({ email: 'x@t.com', auth: s });
      const body = await (await GET(req(signToken(uid)))).json();
      expect(body.auth_status, s).toBe(s);
    }
  });
});
