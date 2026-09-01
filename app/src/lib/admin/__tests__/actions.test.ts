// app/src/lib/admin/__tests__/actions.test.ts
// 后台两个变更动作（钱与权益）。要害五条：
//   ① 发值必经账本，且 balance ≡ Σledger 在每一步之后仍恒等；
//   ② 同 refId 双发只入账一次（幂等）；
//   ③ 调会员写的行带 order_no 操作痕（去痕即红）；
//   ④ 每一笔操作都落 admin_audit（不落即红），撞幂等也落；
//   ⑤ 降档立即生效：当前行被提前到期，新行从此刻起算。
import { beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { getGongdao } from '@/lib/billing/index';
import { getMembership } from '@/lib/billing/fulfillment';
import { GONGDAO_LEDGER_TYPE } from '@/lib/billing/pricing';
import { runMigrations } from '@/lib/db/migrate';
import {
  ADMIN_GRANT_SCENE,
  ADMIN_MEMBERSHIP_DAYS,
  adminGrantGongdao,
  adminOpStamp,
  adminSetMembership,
  isAdminGrantRef,
  newAdminGrantRef,
} from '../actions';
import { ADMIN_ACTION } from '../audit';

const OPERATOR = 1;
let db: Db;
let target: number;

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').run(OPERATOR, 'boss@t.com');
  target = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid);
});

/** 全局对账：凡出现过的 user，balance 必恒等于其 delta 之和。返回核验到的人数。 */
function assertInvariant(): number {
  const rows = db
    .prepare(
      `SELECT u.user_id AS uid, COALESCE(g.balance,0) AS balance, COALESCE(l.s,0) AS ledger_sum
         FROM (SELECT user_id FROM gongdao UNION SELECT user_id FROM gongdao_ledger) u
         LEFT JOIN gongdao g ON g.user_id=u.user_id
         LEFT JOIN (SELECT user_id, SUM(delta) s FROM gongdao_ledger GROUP BY user_id) l
                ON l.user_id=u.user_id`,
    )
    .all() as { uid: number; balance: number; ledger_sum: number }[];
  for (const r of rows) expect(r.balance, `user ${r.uid} balance≠Σledger`).toBe(r.ledger_sum);
  return rows.length;
}

const auditRows = () =>
  db.prepare('SELECT * FROM admin_audit ORDER BY id').all() as {
    operator_uid: number;
    action: string;
    target_uid: number;
    detail_json: string;
  }[];

// ───────────────────────────── 发公道值 ─────────────────────────────

describe('发公道值', () => {
  test('走账本入账：ledger 落「管理员调整」正向行，余额随之涨，对账恒等', () => {
    const ref = newAdminGrantRef(OPERATOR);
    const res = adminGrantGongdao(db, {
      operatorUid: OPERATOR,
      targetUid: target,
      delta: 500,
      note: '客诉补偿',
      refId: ref,
    });
    expect(res).toMatchObject({ ok: true, applied: true, delta: 500, balance: 500 });

    const row = db
      .prepare('SELECT delta, type, ref_id, meta_json FROM gongdao_ledger WHERE ref_id=?')
      .get(ref) as { delta: number; type: string; ref_id: string; meta_json: string };
    expect(row.delta).toBe(500);
    expect(row.type).toBe(GONGDAO_LEDGER_TYPE.admin);
    expect(JSON.parse(row.meta_json)).toMatchObject({
      scene: ADMIN_GRANT_SCENE,
      operator_uid: OPERATOR,
      note: '客诉补偿',
    });
    expect(getGongdao(target, db)).toBe(500);
    expect(assertInvariant()).toBe(1);
  });

  test('同 refId 双发只入账一次（幂等），余额不翻倍，对账仍恒等', () => {
    const ref = newAdminGrantRef(OPERATOR);
    const first = adminGrantGongdao(db, {
      operatorUid: OPERATOR, targetUid: target, delta: 500, note: '补偿', refId: ref,
    });
    const second = adminGrantGongdao(db, {
      operatorUid: OPERATOR, targetUid: target, delta: 500, note: '补偿', refId: ref,
    });
    expect(first).toMatchObject({ ok: true, applied: true });
    expect(second).toMatchObject({ ok: true, applied: false, balance: 500 });

    const n = (db.prepare('SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id=?').get(ref) as { c: number }).c;
    expect(n).toBe(1);
    expect(getGongdao(target, db)).toBe(500);
    expect(assertInvariant()).toBe(1);
  });

  test('不同 refId 各发各的（幂等键只挡重放，不挡第二次真实操作）', () => {
    adminGrantGongdao(db, { operatorUid: OPERATOR, targetUid: target, delta: 100, note: 'a', refId: newAdminGrantRef(OPERATOR) });
    adminGrantGongdao(db, { operatorUid: OPERATOR, targetUid: target, delta: 200, note: 'b', refId: `${adminOpStamp(OPERATOR)}-deadbeef` });
    expect(getGongdao(target, db)).toBe(300);
    assertInvariant();
  });

  test('非正数额被拒：不写账本、不写审计', () => {
    for (const bad of [0, -1, -1000]) {
      expect(adminGrantGongdao(db, {
        operatorUid: OPERATOR, targetUid: target, delta: bad, note: 'x', refId: newAdminGrantRef(OPERATOR),
      })).toEqual({ ok: false, reason: 'bad_amount' });
    }
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });
    expect(auditRows()).toHaveLength(0);
  });

  test('每一笔都落 admin_audit，且 detail 写清金额/备注/幂等键/是否真生效', () => {
    const ref = newAdminGrantRef(OPERATOR);
    adminGrantGongdao(db, { operatorUid: OPERATOR, targetUid: target, delta: 800, note: '道歉', refId: ref });
    adminGrantGongdao(db, { operatorUid: OPERATOR, targetUid: target, delta: 800, note: '道歉', refId: ref });

    const rows = auditRows();
    // 撞幂等那次也要落行：「试过但没生效」与「没试过」必须分得开
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.operator_uid).toBe(OPERATOR);
      expect(r.target_uid).toBe(target);
      expect(r.action).toBe(ADMIN_ACTION.grantGongdao);
    }
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({ delta: 800, note: '道歉', ref_id: ref, applied: true });
    expect(JSON.parse(rows[1].detail_json)).toMatchObject({ applied: false, balance_after: 800 });
  });
});

describe('幂等键形状', () => {
  test('newAdminGrantRef 带操作痕，且只认本操作者', () => {
    const ref = newAdminGrantRef(7);
    expect(ref).toMatch(/^admin-7-\d{10,}-[0-9a-f]{8}$/);
    expect(isAdminGrantRef(ref, 7)).toBe(true);
    expect(isAdminGrantRef(ref, 8)).toBe(false);
    expect(isAdminGrantRef('whatever', 7)).toBe(false);
    // 前缀不能被拿去冒充别人：uid=7 的痕不该被 uid=71 的正则吃下
    expect(isAdminGrantRef(newAdminGrantRef(71), 7)).toBe(false);
  });

  test('adminOpStamp 就是操作痕本体：admin-<操作者uid>-<时间戳>', () => {
    expect(adminOpStamp(2, new Date('2026-09-01T00:00:00Z'))).toBe('admin-2-1788220800000');
  });
});

// ───────────────────────────── 调会员 ─────────────────────────────

describe('调会员', () => {
  test('写 memberships 行，order_no 带 admin-<操作者uid>- 操作痕，时长按选的天数', () => {
    const orderNo = adminOpStamp(OPERATOR);
    const res = adminSetMembership(db, {
      operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 365, orderNo,
    });
    expect(res.ok).toBe(true);

    const row = db.prepare('SELECT plan, order_no, started_at, expires_at FROM memberships WHERE user_id=?')
      .get(target) as { plan: string; order_no: string; started_at: string; expires_at: string };
    expect(row.plan).toBe('pro');
    // 操作痕：去掉前缀（写 NULL / 写业务订单号）即红
    expect(row.order_no).toBe(orderNo);
    expect(row.order_no.startsWith(`admin-${OPERATOR}-`)).toBe(true);
    // 365 天：与套餐自带的 30 天不同，证明 overrideDays 真的生效了
    const span = (Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) - Date.parse(`${row.started_at.replace(' ', 'T')}Z`)) / 86400000;
    expect(Math.round(span)).toBe(365);
    expect(getMembership(db, target)).toMatchObject({ active: true, plan: 'pro' });
  });

  test('三档时长都收，其余一律拒（不写行、不写审计）', () => {
    for (const d of ADMIN_MEMBERSHIP_DAYS) {
      expect(adminSetMembership(db, {
        operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: d, orderNo: `admin-${OPERATOR}-${d}`,
      }).ok).toBe(true);
    }
    for (const bad of [0, 1, 30, 366, -31]) {
      expect(adminSetMembership(db, {
        operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: bad, orderNo: `admin-${OPERATOR}-bad${bad}`,
      })).toEqual({ ok: false, reason: 'bad_days' });
    }
    expect((db.prepare('SELECT COUNT(*) c FROM memberships').get() as { c: number }).c).toBe(3);
    expect(auditRows()).toHaveLength(3);
  });

  test('升档：新行到期更晚，立刻成为当前档，旧行不动', () => {
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: 31, orderNo: 'admin-1-a' });
    const before = getMembership(db, target).expiresAt;
    const res = adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 92, orderNo: 'admin-1-b' });
    expect(res).toMatchObject({ ok: true, downgraded: false });
    expect(getMembership(db, target).plan).toBe('pro');
    // 旧的 entry 行没被提前到期
    const entryRow = db.prepare("SELECT expires_at FROM memberships WHERE order_no='admin-1-a'").get() as { expires_at: string };
    expect(entryRow.expires_at).toBe(before);
  });

  test('降档：当前行被提前到期到此刻，新行从此刻起算，立即生效', () => {
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 365, orderNo: 'admin-1-hi' });
    const res = adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: 31, orderNo: 'admin-1-lo' });
    expect(res).toMatchObject({ ok: true, downgraded: true, prevPlan: 'pro' });

    // 立即生效：当前档已经是 entry，而不是等 pro 那 365 天走完
    expect(getMembership(db, target).plan).toBe('entry');
    // 旧行仍在（历史事实不删），只是到期被提前到此刻，已不再有效
    const hi = db.prepare("SELECT expires_at FROM memberships WHERE order_no='admin-1-hi'").get() as { expires_at: string };
    expect(hi).toBeTruthy();
    const stillActive = db.prepare(
      "SELECT COUNT(*) c FROM memberships WHERE order_no='admin-1-hi' AND expires_at > datetime('now')",
    ).get() as { c: number };
    expect(stillActive.c).toBe(0);
  });

  test('同档续期按叠加算（不提前到期）', () => {
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: 31, orderNo: 'admin-1-1' });
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: 31, orderNo: 'admin-1-2' });
    const rows = db.prepare('SELECT expires_at FROM memberships WHERE user_id=? ORDER BY id').all(target) as
      { expires_at: string }[];
    const gap = (Date.parse(`${rows[1].expires_at.replace(' ', 'T')}Z`) - Date.parse(`${rows[0].expires_at.replace(' ', 'T')}Z`)) / 86400000;
    expect(Math.round(gap)).toBe(31);
  });

  test('order_no 撞已有行 → 幂等短路：applied=false，不提前到期、不写新行、不重复落审计', () => {
    // 同一把 order_no（前端的 op_ref）的重试：参数与首发一致，是同一操作的重放，不是第二次真实操作。
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 365, orderNo: 'admin-1-dup' });
    const before = getMembership(db, target);
    const res = adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 365, orderNo: 'admin-1-dup' });
    // 撞幂等不是失败：回成功 + applied=false + 首次结果，重试因此看到成功而非报错
    expect(res).toMatchObject({ ok: true, applied: false });
    // 首发那一行原封不动：没被叠加、没被提前到期
    expect(getMembership(db, target)).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) c FROM memberships').get() as { c: number }).c).toBe(1);
    expect(auditRows()).toHaveLength(1);
  });

  test('每一笔调会员都落 admin_audit，detail 写清档位/天数/订单号/是否降档/到期', () => {
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'pro', days: 92, orderNo: 'admin-1-x' });
    adminSetMembership(db, { operatorUid: OPERATOR, targetUid: target, plan: 'entry', days: 31, orderNo: 'admin-1-y', note: '退款降档' });

    const rows = auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe(ADMIN_ACTION.grantMembership);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({ plan: 'pro', days: 92, order_no: 'admin-1-x', downgraded: false });
    expect(JSON.parse(rows[1].detail_json)).toMatchObject({ plan: 'entry', days: 31, downgraded: true, prev_plan: 'pro', note: '退款降档' });
    expect(JSON.parse(rows[1].detail_json).expires_at).toBeTruthy();
  });
});

describe('混打后对账仍恒等', () => {
  test('发值 + 调会员交替 20 轮，balance ≡ Σledger 每步成立', () => {
    for (let i = 0; i < 20; i++) {
      adminGrantGongdao(db, {
        operatorUid: OPERATOR, targetUid: target, delta: 10 + i, note: `第${i}笔`,
        refId: `${adminOpStamp(OPERATOR)}-${i.toString(16).padStart(8, '0')}`,
      });
      adminSetMembership(db, {
        operatorUid: OPERATOR, targetUid: target,
        plan: i % 3 === 0 ? 'pro' : i % 3 === 1 ? 'entry' : 'standard',
        days: ADMIN_MEMBERSHIP_DAYS[i % 3], orderNo: `admin-${OPERATOR}-m${i}`,
      });
      expect(assertInvariant()).toBe(1);
    }
    expect(auditRows()).toHaveLength(40);
  });
});
