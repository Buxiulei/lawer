// app/src/app/api/v1/redeem/__tests__/route.test.ts
// POST /api/v1/redeem 的两条红线：
//   ① 四种失败**同形**——这个接口不许成为「这条码存不存在」的预言机；
//   ② 失败限速——同形之后，撞库唯一剩下的手段就是量，量得由限速来挡。
// 外加到账走的是 lib/billing 那条唯一入口（ledger 有流水、余额与流水求和相等）。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

let POST: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;
let issueRedeemCodes: typeof import('@/lib/billing/redeem').issueRedeemCodes;
let REDEEM_FAIL_MAX: number;

function req(token: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/v1/redeem', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-redeem-${crypto.randomUUID()}.db`);
  POST = (await import('../route')).POST;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  const redeem = await import('@/lib/billing/redeem');
  issueRedeemCodes = redeem.issueRedeemCodes;
  REDEEM_FAIL_MAX = redeem.REDEEM_FAIL_MAX;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec(
    'DELETE FROM gongdao_ledger; DELETE FROM gongdao; DELETE FROM redemption_codes; DELETE FROM ip_quota_events; DELETE FROM users;',
  );
});

function makeUser(email = 'u@t.com'): number {
  return Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
}

async function post(uid: number | null, code: unknown) {
  const res = await POST(req(uid === null ? undefined : signToken(uid), { code }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('鉴权', () => {
  test('无 token → 401', async () => {
    const r = await post(null, 'WHATEVER');
    expect(r.status).toBe(401);
  });
});

describe('到账', () => {
  test('兑成功：面值入账，余额 ≡ Σledger，流水类型是「兑换」', async () => {
    const uid = makeUser();
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 300 });
    const r = await post(uid, code);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, gongdao: 300, balance: 300 });

    const rows = db.prepare('SELECT delta, type, ref_id FROM gongdao_ledger WHERE user_id=?').all(uid) as {
      delta: number;
      type: string;
      ref_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('兑换');
    expect(rows[0].ref_id).toMatch(/^redeem-\d+$/);
    const bal = (db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(uid) as { balance: number }).balance;
    const sum = (db.prepare('SELECT SUM(delta) s FROM gongdao_ledger WHERE user_id=?').get(uid) as { s: number }).s;
    expect(bal).toBe(sum);
  });

  test('大小写与首尾空白照样兑得动', async () => {
    const uid = makeUser();
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 60 });
    expect((await post(uid, `  ${code.toLowerCase()} `)).status).toBe(200);
  });

  test('同一条码第二次兑不到账（幂等）', async () => {
    const uid = makeUser();
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 300 });
    await post(uid, code);
    const second = await post(uid, code);
    expect(second.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 1 });
    expect(
      (db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(uid) as { balance: number }).balance,
    ).toBe(300);
  });

  test('空码不算一次失败（那是手滑，不是撞库）', async () => {
    const uid = makeUser();
    const r = await post(uid, '   ');
    expect(r.status).toBe(400);
    expect(r.body.error_code).toBe('REDEEM_CODE_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) c FROM ip_quota_events').get()).toEqual({ c: 0 });
  });
});

describe('失败态同形：这个接口不当「码存不存在」的预言机', () => {
  /**
   * 四种失败**逐字节**一样。
   *
   * 【为什么连 status 和 error_code 都要一样】只要有任何一个可分辨的位，撞库的人就拿到了
   * 一个判据：能区分「这条不存在」和「这条存在但已被兑」，等于确认了码的字母表、长度与
   * 发码规律，30^16 的搜索空间随即塌掉。面值是凭空造出的公道值，这个预言机收的是真钱。
   */
  test('码不存在 / 已被兑 / 已过期 / 已停用 —— 四种响应完全相同', async () => {
    const uid = makeUser();
    const [used] = issueRedeemCodes(db, { count: 1, gongdaoValue: 10 });
    await post(uid, used); // 先兑掉

    const [expired] = issueRedeemCodes(db, {
      count: 1,
      gongdaoValue: 10,
      expiresAt: '2000-01-01 00:00:00',
    });
    const [disabled] = issueRedeemCodes(db, { count: 1, gongdaoValue: 10 });
    db.prepare('UPDATE redemption_codes SET enabled=0 WHERE code=?').run(disabled);

    // 每种失败换一个新账号发，免得前面的失败把后面的账号锁了（锁的响应本来就该不一样）
    const shots = await Promise.all(
      [
        ['不存在', '2222222222222222'],
        ['已被兑', used],
        ['已过期', expired],
        ['已停用', disabled],
      ].map(async ([label, code], i) => {
        const u = makeUser(`probe${i}@t.com`);
        const r = await post(u, code);
        return { label, status: r.status, body: JSON.stringify(r.body) };
      }),
    );

    const first = shots[0];
    for (const s of shots) {
      expect(s.status, `${s.label} 的 status 与「${first.label}」不同`).toBe(first.status);
      expect(s.body, `${s.label} 的响应体与「${first.label}」不同`).toBe(first.body);
    }
    // 正对照：断言不是落在空对象上——响应确实带着那句模糊话
    expect(first.body).toContain('REDEEM_INVALID');
    expect(first.body).toContain('兑换码无效或已使用');
    // 反对照：四种 reason 的具体说法一个都不许漏出去
    for (const leak of ['不存在', '已停用', '已过期', '已被使用']) {
      expect(first.body).not.toContain(leak);
    }
  });
});

describe('爆破锁', () => {
  test('同账号失败到上限就锁住：连正确的码也兑不了', async () => {
    const uid = makeUser();
    for (let i = 0; i < REDEEM_FAIL_MAX; i += 1) {
      const r = await post(uid, `BADCODE${String(i).padStart(9, '0')}`);
      expect(r.status, `第 ${i + 1} 次失败不该被锁`).toBe(400);
      expect(r.body.error_code).toBe('REDEEM_INVALID');
    }

    // 第 MAX+1 次：锁上了，返回的是限速而不是那句模糊话
    const locked = await post(uid, 'BADCODEZZZZZZZZZ');
    expect(locked.status).toBe(429);
    expect(locked.body.error_code).toBe('REDEEM_LOCKED');

    // 关键的一条：**锁上之后连真码也兑不了**。少了这条，「锁」可以被实现成
    // 「只挡错码」——而撞库的人手里迟早会攒出一条真码，那时锁等于不存在。
    const [good] = issueRedeemCodes(db, { count: 1, gongdaoValue: 999 });
    const blocked = await post(uid, good);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error_code).toBe('REDEEM_LOCKED');
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });

    // 锁是**按账号**的：另一个人不受连累（按 IP 计数的话，同一出口的同事会一起被锁）
    const other = makeUser('other@t.com');
    expect((await post(other, good)).status).toBe(200);
  });

  test('成功的兑换不消耗失败额度', async () => {
    const uid = makeUser();
    const codes = issueRedeemCodes(db, { count: REDEEM_FAIL_MAX + 2, gongdaoValue: 1 });
    for (const c of codes) expect((await post(uid, c)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM ip_quota_events').get()).toEqual({ c: 0 });
  });

  test('失败计数不与验证码的 IP 限流串味：键是账号维度的，不是某个 IP', async () => {
    const uid = makeUser();
    await post(uid, 'NOSUCHCODE0000000');
    const rows = db.prepare('SELECT ip FROM ip_quota_events').all() as { ip: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toBe(`redeem-fail:${uid}`);
    // 不能长得像个 IP：像的话，某个真实 IP 的发码额度会被兑换失败悄悄吃掉
    expect(rows[0].ip).not.toMatch(/^\d+(\.\d+){3}$/);
  });
});
