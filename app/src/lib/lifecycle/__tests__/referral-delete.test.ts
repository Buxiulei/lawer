// app/src/lib/lifecycle/__tests__/referral-delete.test.ts
// 转介删除请求的三臂：成功 / 拒绝 / 幂等。
//
// 【这一组最要紧的一条是「不许把没做的事说成做了」】对方（NBDpsy）的内部接口契约到 v1.4
// 为止只有实名互认与投递转介两条，没有删除通道。回一句「已删除」是这里最容易犯、
// 也最难被发现的错：用户会据此以为自己的资料在对方那边已经没了，而它还在。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import { insertReferral } from '@/lib/db/referrals';

import { listReferralDeleteRequests, requestReferralDelete } from '../referral-delete';

let db: Database.Database;
let uid: number;
let other: number;
let caseId: number;
let referralId: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare("INSERT INTO users (email) VALUES ('a@t.com')").run().lastInsertRowid);
  other = Number(db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '甲的档案').lastInsertRowid,
  );
  referralId = insertReferral(db, {
    caseId,
    userId: uid,
    payloadJson: '{"identity":{}}',
    consentAt: '2026-09-01 00:00:00',
  });
  db.prepare("UPDATE referrals SET status='sent', external_ref='LEAD-9' WHERE id=?").run(referralId);
});

describe('成功臂', () => {
  it('记下请求，并把对方那条线索号一起记上（人工转达时要报给对方）', () => {
    const res = requestReferralDelete({
      db,
      userId: uid,
      referralId,
      reason: '不想让他们联系我了',
      now: new Date('2026-09-07T00:00:00Z'),
    });
    if (!res.ok) throw new Error(`本该成功：${res.message}`);
    expect(res.status).toBe('recorded');
    expect(res.already_requested).toBe(false);
    expect(res.requested_at).toBe('2026-09-07 00:00:00');

    const row = db
      .prepare('SELECT referral_id, user_id, external_ref, status, reason FROM referral_delete_requests')
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      referral_id: referralId,
      user_id: uid,
      external_ref: 'LEAD-9',
      status: 'recorded',
      reason: '不想让他们联系我了',
    });
  });

  it('**不许说成已删除**：delivered 恒 false，note 里明说还没发给对方（变异：把 delivered 改成 true → 本条红）', () => {
    const res = requestReferralDelete({ db, userId: uid, referralId });
    if (!res.ok) throw new Error('本该成功');
    expect(res.delivered).toBe(false);
    expect(res.note).toContain('还没有自动发给');
    expect(res.note).toContain('人工');
    // 状态留在 recorded 而不是 unsupported：对方开出通道那天要能按它把积压的请求全捞出来重发
    expect(res.status).toBe('recorded');
  });

  it('清单读得回来，且 delivered 与状态同源', () => {
    requestReferralDelete({ db, userId: uid, referralId });
    const list = listReferralDeleteRequests(db, uid);
    expect(list).toHaveLength(1);
    expect(list[0].referral_id).toBe(referralId);
    expect(list[0].delivered).toBe(false);
  });
});

describe('拒绝臂', () => {
  it('别人的转介 ⇒ REFERRAL_NOT_FOUND 且零写入', () => {
    const res = requestReferralDelete({ db, userId: other, referralId });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errorCode).toBe('REFERRAL_NOT_FOUND');
    expect(db.prepare('SELECT COUNT(*) AS n FROM referral_delete_requests').get()).toEqual({ n: 0 });
  });

  it('不存在的转介 ⇒ 同一句话（不区分「不存在」与「不是你的」）', () => {
    const res = requestReferralDelete({ db, userId: uid, referralId: 999_999 });
    expect(!res.ok && res.errorCode).toBe('REFERRAL_NOT_FOUND');
  });

  it('referral_id 不是正整数 ⇒ 同一句 REFERRAL_NOT_FOUND', () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      const res = requestReferralDelete({ db, userId: uid, referralId: bad });
      expect(!res.ok && res.errorCode, String(bad)).toBe('REFERRAL_NOT_FOUND');
    }
  });
});

describe('幂等臂', () => {
  it('同一条转介提两次都成功，第二次 already_requested=true 且只有一行（变异：去掉 findReferralDeleteRequest 那一支 → 本条红）', () => {
    const first = requestReferralDelete({
      db,
      userId: uid,
      referralId,
      now: new Date('2026-09-07T00:00:00Z'),
    });
    const second = requestReferralDelete({
      db,
      userId: uid,
      referralId,
      now: new Date('2026-09-20T00:00:00Z'),
    });
    if (!first.ok || !second.ok) throw new Error('两次都该成功');
    expect(second.already_requested).toBe(true);
    expect(second.request_id).toBe(first.request_id);
    // 首次提出的时刻不许被第二次改写
    expect(second.requested_at).toBe('2026-09-07 00:00:00');
    expect(db.prepare('SELECT COUNT(*) AS n FROM referral_delete_requests').get()).toEqual({ n: 1 });
  });
});

describe('请求要比转介活得久', () => {
  it('案件被硬删之后，删除请求这一行还在（referral_id 置空，user_id 与时刻留着）', () => {
    requestReferralDelete({ db, userId: uid, referralId });
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
    // 转介随案级联没了
    expect(db.prepare('SELECT COUNT(*) AS n FROM referrals').get()).toEqual({ n: 0 });
    // 我们对外的那句承诺留着
    const rows = listReferralDeleteRequests(db, uid);
    expect(rows).toHaveLength(1);
    expect(rows[0].referral_id).toBeNull();
  });
});
