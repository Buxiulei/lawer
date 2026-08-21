// app/src/lib/auth/__tests__/onboarding.test.ts
// 注册完成（手机 + 邮箱双验证齐）时服务端自动开通默认案件。
// 这条钩子挂在 verifyEmailCode 里，故从"验邮箱验证码"这个真实入口测起。
import { beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

import * as store from '@/lib/db/otp';
import { toSql } from '@/lib/db/time';
import { verifyEmailCode } from '../otp';
import { makeTestDb } from './helpers';

const EMAIL = 'user@example.com';
const CODE = '654321';
const NOW = new Date('2026-08-20T10:00:00Z');

/** 建一个手机已验证的账号，并塞一条可用的邮箱验证码 */
function seedPendingEmail(db: Database): number {
  const userId = store.insertUser(db, {
    phoneEnc: 'v1:whatever',
    phoneHash: crypto.randomUUID(),
    verifiedAt: toSql(NOW),
  });
  store.insertEmailCode(db, {
    email: EMAIL,
    code: CODE,
    expiresAt: toSql(new Date(NOW.getTime() + 5 * 60 * 1000)),
    createdAt: toSql(NOW),
  });
  return userId;
}

function verify(db: Database, userId: number) {
  return verifyEmailCode(db, { userId, email: EMAIL, code: CODE }, { now: NOW });
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
});

describe('注册完成自动开通', () => {
  test('双验证齐 → 建默认案件 + 一条欢迎事件', () => {
    const db = makeTestDb();
    const userId = seedPendingEmail(db);

    const result = verify(db, userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.onboarding).toMatchObject({ isNew: true });

    const kase = db.prepare('SELECT * FROM cases WHERE user_id = ?').get(userId) as {
      id: number;
      title: string;
      stage: string;
      district: string;
    };
    expect(kase).toMatchObject({ title: '我的案件', stage: '风声', district: '朝阳' });
    expect(result.onboarding!.caseId).toBe(kase.id);

    const events = db
      .prepare('SELECT kind, title, detail FROM timeline_events WHERE case_id = ?')
      .all(kase.id) as { kind: string; title: string; detail: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('系统动作');
    expect(events[0].detail).toBeTruthy();
  });

  test('二次验证邮箱不重复建案，onboarding 回 is_new=false', () => {
    const db = makeTestDb();
    const userId = seedPendingEmail(db);
    verify(db, userId);

    // 再发一条码走第二遍（用户重新验了一次邮箱）
    store.insertEmailCode(db, {
      email: EMAIL,
      code: CODE,
      expiresAt: toSql(new Date(NOW.getTime() + 5 * 60 * 1000)),
      createdAt: toSql(NOW),
    });
    const again = verify(db, userId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.onboarding).toMatchObject({ isNew: false });

    const count = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE user_id = ?').get(userId) as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  test('手机没验过（只有邮箱）→ 不建案', () => {
    const db = makeTestDb();
    const userId = seedPendingEmail(db);
    db.prepare('UPDATE users SET phone_verified_at = NULL WHERE id = ?').run(userId);

    const result = verify(db, userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.onboarding).toBeUndefined();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n,
    ).toBe(0);
  });

  test('建案失败不阻断登录：照样换发 token，且不留半截档案', () => {
    const db = makeTestDb();
    const userId = seedPendingEmail(db);
    // 让欢迎事件写不进去（模拟建案链路故障）：整个建案事务应回滚
    db.exec('DROP TABLE timeline_events');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = verify(db, userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBeTruthy();
    expect(result.onboarding).toBeUndefined();
    expect(logged).toHaveBeenCalled();
    // 事务回滚：案件不该单独留下来
    expect((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n).toBe(0);
    // 邮箱验证本身照常生效
    expect(store.findUserById(db, userId)!.email_verified_at).toBeTruthy();

    logged.mockRestore();
  });
});
