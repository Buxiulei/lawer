// app/src/lib/auth/__tests__/register-grant.test.ts
// 注册赠送接线（2026-08-28 P0）。
//
// 【判据是"新用户能用"，不是"账本有行"】REGISTER_GRANT_GONGDAO 这个常量和
// gongdaoGrant 这个机制在此之前就都存在、也都被测过——**缺的只是注册时没人调用它**。
// 所以断言"有一行 注册赠送"会在接线前后同样容易写、也同样容易在下次断线时继续绿。
// 真正会红的判据是：**新账号能不能过 gongdaoGate**。产线实况就是它过不了：
// 2026-08-28 两个真实账号余额均为 0，其中一个是负责人本人，第一个计费动作即被拦。
import crypto from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getGongdao, gongdaoGate } from '@/lib/billing';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '@/lib/billing/pricing';
import { hashLookup } from '@/lib/crypto';
import { sendPhoneCode, verifyPhoneCode } from '../otp';
import { lastSmsCode, makeTestDb } from './helpers';

const PHONE = '13800138000';
const IP = '203.0.113.9';

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  vi.restoreAllMocks();
});

/** 走完整的「发码 → 验码」建号流程，返回 uid */
async function register(
  db: ReturnType<typeof makeTestDb>,
  phone = PHONE,
  now = new Date('2026-08-28T00:00:00.000Z'),
): Promise<number> {
  await sendPhoneCode(db, { phone, ip: IP }, {
    sendSms: async () => {},
    sendEmail: async () => {},
    now,
  });
  const code = lastSmsCode(db, hashLookup(phone));
  const res = verifyPhoneCode(db, { phone, code }, { now });
  if (!res.ok) throw new Error('前置失败：建号没走通');
  const row = db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

describe('注册赠送', () => {
  test('🔴 新账号注册完就能过计费门槛（这是判据本身）', async () => {
    const db = makeTestDb();
    const uid = await register(db);
    // 接线之前这里恒为 false —— 那正是产线上两个真实账号的处境
    expect(gongdaoGate(uid, db)).toBe(true);
  });

  test('余额恰为 spec 值，不是随手一个数', async () => {
    const db = makeTestDb();
    const uid = await register(db);
    expect(getGongdao(uid, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('账本里落的是「注册赠送」这一类，不是混进充值', async () => {
    const db = makeTestDb();
    const uid = await register(db);
    const rows = db
      .prepare('SELECT type, delta, ref_id FROM gongdao_ledger WHERE user_id=?')
      .all(uid) as { type: string; delta: number; ref_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: GONGDAO_LEDGER_TYPE.register,
      delta: REGISTER_GRANT_GONGDAO,
      ref_id: `reg-${uid}`,
    });
  });

  test('同一个人再走一遍登录流程，不会二次发放', async () => {
    const db = makeTestDb();
    const uid = await register(db);
    // 推过 60 秒重发窗——否则第二次发码被限流，拿到的是上一条已用过的码
    await register(db, PHONE, new Date('2026-08-28T00:05:00.000Z'));
    expect(getGongdao(uid, db)).toBe(REGISTER_GRANT_GONGDAO);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM gongdao_ledger WHERE user_id=?').get(uid) as { c: number })
        .c,
    ).toBe(1);
  });

  test('两个不同的人各拿各的，refId 不串号', async () => {
    const db = makeTestDb();
    const a = await register(db, '13800138000');
    const b = await register(db, '13900139000', new Date('2026-08-28T00:05:00.000Z'));
    expect(a).not.toBe(b);
    expect(getGongdao(a, db)).toBe(REGISTER_GRANT_GONGDAO);
    expect(getGongdao(b, db)).toBe(REGISTER_GRANT_GONGDAO);
  });

  test('建号与赠送同生同死：赠送炸了就不该留下一个用不了的账号', async () => {
    const db = makeTestDb();
    // 让入账那一步失败（模拟账本层出问题）
    const real = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO gongdao_ledger')) {
        throw new Error('模拟账本写入失败');
      }
      return real(sql);
    }) as typeof db.prepare);

    await expect(register(db)).rejects.toThrow();
    vi.restoreAllMocks();

    // 【关键】不该留下半个账号：建号失败用户会重试，
    // 而一个"建成了却过不了门槛"的账号看起来一切正常，人会以为是产品坏了。
    const n = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    expect(n).toBe(0);
  });
});
