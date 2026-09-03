// app/src/app/api/v1/admin/realname/__tests__/notify-order.test.ts
//
// 一条判据，一件事：**通知发出去的那一刻，审核必须已经落定并提交**。
//
// 【为什么单独一个文件】这里要把 lib/notify/email 的 sendMail 换成一个探针，
// 而隔壁 routes.test.ts 的判据 ⑥ 要的正是"真的走到 sendMail 并真的抛"那条路径——
// 同一个文件里 mock 掉，那条判据就变成了"我们自己扮演的失败"，牙磨掉一颗。
//
// 【探针查什么】不只查 users 已是「已实名」：better-sqlite3 的事务里读得到未提交的写，
// 光看这一条区分不出"事务里发信"与"事务后发信"。所以同时查 db.inTransaction === false
// ——那才是"已经提交"这件事本身。顺序错了的现象：SMTP 一超时就把已经核过的实名回滚，
// 管理员看到报错、库里什么都没变，而用户那边还停在待审。
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';

/** 探针的当前实现。默认照旧抛（与"SMTP 没配"同形），逐条用例自己换。 */
const probe = vi.hoisted(() => ({
  impl: null as null | ((to: string) => void | Promise<void>),
}));

vi.mock('@/lib/notify/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify/email')>();
  return {
    ...actual,
    sendMail: async (to: string) => {
      if (!probe.impl) throw new Error('SMTP 凭证未配置');
      await probe.impl(to);
    },
  };
});

type IdCtx = { params: Promise<{ id: string }> };

let approvePost: (req: Request, ctx: IdCtx) => Promise<Response>;
let rejectPost: (req: Request, ctx: IdCtx) => Promise<Response>;
let db: Database;
let ADMIN = 0;
let TARGET = 0;

const idCtx = (id: number): IdCtx => ({ params: Promise.resolve({ id: String(id) }) });

function post(url: string, body: unknown, token: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function submit(userId: number): Promise<number> {
  const { initPassportRealname } = await import('@/lib/auth/passport-realname');
  const r = initPassportRealname(db, {
    userId,
    realName: '张三',
    passportNo: 'E12345678',
    idPage: { bytes: Buffer.from(`idpage-${crypto.randomUUID()}`), mime: 'image/jpeg' },
    selfie: { bytes: Buffer.from(`selfie-${crypto.randomUUID()}`), mime: 'image/png' },
  });
  if (!r.ok) throw new Error(`前置失败：${r.message}`);
  return r.verificationId;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-adm-rn-order-${crypto.randomUUID()}.db`);
  process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-adm-rn-order-files-'));

  approvePost = (await import('../[id]/approve/route')).POST;
  rejectPost = (await import('../[id]/reject/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  probe.impl = null;
  db.prepare('DELETE FROM admin_audit').run();
  db.prepare('DELETE FROM realname_verifications').run();
  db.prepare('DELETE FROM files').run();
  db.prepare('DELETE FROM users').run();
  ADMIN = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('boss@t.com').lastInsertRowid);
  TARGET = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('zhang@example.com').lastInsertRowid);
  process.env.ADMIN_UIDS = String(ADMIN);
});

describe('🔴 通知发出去时，审核已经落定并提交', () => {
  test('approve：探针里看到的是「已实名」+ 一行审计 + 不在事务中', async () => {
    const vid = await submit(TARGET);
    const seen: { authStatus: string; audit: number; inTransaction: boolean; to: string }[] = [];
    probe.impl = (to) => {
      seen.push({
        to,
        authStatus: (db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a,
        audit: (db.prepare('SELECT COUNT(*) c FROM admin_audit').get() as { c: number }).c,
        inTransaction: db.inTransaction,
      });
    };

    const res = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(200);
    expect((await res.json()).notified).toBe('sent');

    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe('zhang@example.com');
    // 【变异对照】把 notifyRealnameReviewed 挪到 adminApprovePassportRealname 之前
    // → authStatus 还是「待审」、audit 还是 0 → 红
    expect(seen[0].authStatus).toBe('已实名');
    expect(seen[0].audit).toBe(1);
    // 【变异对照】把发信塞进 db.transaction 的回调里 → inTransaction 为 true → 红
    expect(seen[0].inTransaction).toBe(false);
  });

  test('reject：同一条纪律（探针里已是「未认证」且流水已转未通过）', async () => {
    const vid = await submit(TARGET);
    const seen: { authStatus: string; status: string; inTransaction: boolean }[] = [];
    probe.impl = () => {
      seen.push({
        authStatus: (db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a,
        status: (db.prepare('SELECT status s FROM realname_verifications WHERE id=?').get(vid) as { s: string }).s,
        inTransaction: db.inTransaction,
      });
    };

    const res = await rejectPost(
      post(`/api/v1/admin/realname/${vid}/reject`, { reason: '照片模糊' }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].authStatus).toBe('未认证');
    expect(seen[0].status).toBe('未通过');
    expect(seen[0].inTransaction).toBe(false);
  });

  test('探针本身是活的：不换实现时照旧走到"发不出去"，而审核仍然落定', async () => {
    const vid = await submit(TARGET);
    const res = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect((await res.json()).notified).toBe('failed');
    expect((db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a).toBe('已实名');
  });
});
