// app/src/lib/lifecycle/__tests__/case-delete.test.ts
// 删除案件的三臂：成功 / 拒绝 / 幂等，外加两条只有删除才有的要害。
//
// 【这一组判据要拦的是什么】删除是本仓唯一一个「做错了没法补」的动作，而它的三种错法
// 在外部全都是 200：
//   · 一步就删了（用户没被问过第二遍）——回包与两步式的第二步长得一模一样；
//   · 删了但读侧还看得见（软删标记没接进取数口）——页面正常、案子还在；
//   · 删了但免登录分享链接还活着——用户以为门关上了，而链接照样打得开。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import * as store from '@/lib/db/cases';
import { createShare, readShare } from '@/lib/shares';

import { caseDeleteConfirmToken, deleteCase } from '../case-delete';
import { RETENTION_DAYS } from '../retention';

let db: Database.Database;
let uid: number;
let other: number;
let caseId: number;

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
});

function token(): string {
  const row = store.findCaseByIdIncludingDeleted(db, caseId)!;
  return caseDeleteConfirmToken(row);
}

describe('第一步：只出确认单，一行都不删', () => {
  it('不带 confirm_token ⇒ stage=confirm，案件仍在（变异：把 confirm 那一支改成直接执行 → 本条红）', () => {
    const res = deleteCase({ db, caseId, userId: uid });
    expect(res.ok).toBe(true);
    expect(res.ok && res.stage).toBe('confirm');
    // 关键：**案件必须还在**。这是「两步」这件事唯一验得出来的地方
    expect(store.findCaseById(db, caseId)).toBeDefined();
    expect(cases.listCases(db, { userId: uid }).cases).toHaveLength(1);
  });

  it('确认单里逐条写着会删什么、什么会留下，以及保留期天数', () => {
    const res = deleteCase({ db, caseId, userId: uid });
    if (!res.ok || res.stage !== 'confirm') throw new Error('本该是确认单');
    expect(res.removes.length).toBeGreaterThan(0);
    // keeps 比 removes 更要紧：用户最担心的是「已经出过的证会不会没了」
    expect(res.keeps.join('')).toContain('存证证明');
    expect(res.retention_days).toBe(RETENTION_DAYS);
    expect(res.confirm_token).toHaveLength(32);
    expect(res.note).toContain('本次没有删除任何东西');
  });

  it('令牌不可猜：两个案子的确认令牌不同', () => {
    const second = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '第二个').lastInsertRowid,
    );
    const a = deleteCase({ db, caseId, userId: uid });
    const b = deleteCase({ db, caseId: second, userId: uid });
    if (!a.ok || a.stage !== 'confirm' || !b.ok || b.stage !== 'confirm') throw new Error('本该是确认单');
    expect(a.confirm_token).not.toBe(b.confirm_token);
  });
});

describe('第二步：成功臂', () => {
  it('带对令牌 ⇒ 软删，读侧再也取不到（变异：findCaseById 去掉 deleted_at 过滤 → 本条红）', () => {
    const res = deleteCase({ db, caseId, userId: uid, confirmToken: token() });
    expect(res.ok && res.stage).toBe('deleted');
    expect(res.ok && res.stage === 'deleted' && res.already_deleted).toBe(false);

    // 读侧三处一起验：单条读、清单读、领域层的归属校验
    expect(store.findCaseById(db, caseId)).toBeUndefined();
    expect(cases.listCases(db, { userId: uid }).cases).toEqual([]);
    const got = cases.getCase(db, { caseId, userId: uid });
    expect(got.ok).toBe(false);
    expect(!got.ok && got.errorCode).toBe('CASE_NOT_FOUND');
    // 行本身还在（30 日后才真删）
    expect(store.findCaseByIdIncludingDeleted(db, caseId)).toBeDefined();
  });

  it('删除当场收回免登录分享链接（变异：把 revokeCaseShares 那一句删掉 → 本条红）', () => {
    const draftId = Number(
      db
        .prepare("INSERT INTO drafts (case_id, kind, title, content) VALUES (?,'异议函','稿','正文')")
        .run(caseId).lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, draftId });
    if (!share.ok) throw new Error('建链接失败');
    expect(readShare(db, share.token).state).toBe('ok');

    const res = deleteCase({ db, caseId, userId: uid, confirmToken: token() });
    expect(res.ok && res.stage === 'deleted' && res.shares_revoked).toBe(1);

    // 收回之后那条链接读出来的是「已撤销」，不是「不存在」——两者对拿到链接的人是两句话
    expect(readShare(db, share.token).state).toBe('revoked');
  });

  it('到期时刻 = 删除时刻 + 保留期', () => {
    const at = new Date('2026-09-07T00:00:00Z');
    const res = deleteCase({ db, caseId, userId: uid, confirmToken: token(), now: at });
    if (!res.ok || res.stage !== 'deleted') throw new Error('本该删掉');
    expect(res.deleted_at).toBe('2026-09-07 00:00:00');
    expect(res.purge_after).toBe('2026-10-07 00:00:00');
  });
});

describe('拒绝臂', () => {
  it('令牌对不上 ⇒ INVALID_CONFIRM_TOKEN 且零删除', () => {
    const res = deleteCase({ db, caseId, userId: uid, confirmToken: 'f'.repeat(32) });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errorCode).toBe('INVALID_CONFIRM_TOKEN');
    expect(store.findCaseById(db, caseId)).toBeDefined();
  });

  it('拿别人的案子删 ⇒ CASE_NOT_FOUND（连确认单都不给，否则等于承认这个编号存在）', () => {
    const res = deleteCase({ db, caseId, userId: other });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errorCode).toBe('CASE_NOT_FOUND');
    expect(store.findCaseById(db, caseId)).toBeDefined();
  });

  it('别人拿着**正确**的令牌也删不掉（归属先于令牌）', () => {
    const stolen = token();
    const res = deleteCase({ db, caseId, userId: other, confirmToken: stolen });
    expect(!res.ok && res.errorCode).toBe('CASE_NOT_FOUND');
    expect(store.findCaseById(db, caseId)).toBeDefined();
  });

  it('case_id 不是正整数 ⇒ 同一句 CASE_NOT_FOUND', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const res = deleteCase({ db, caseId: bad, userId: uid });
      expect(!res.ok && res.errorCode, String(bad)).toBe('CASE_NOT_FOUND');
    }
  });
});

describe('幂等臂', () => {
  it('删两次都成功，第二次 already_deleted=true 且首次删除时刻不变（变异：markCaseDeleted 去掉 IS NULL 条件 → 本条红）', () => {
    const first = deleteCase({
      db,
      caseId,
      userId: uid,
      confirmToken: token(),
      now: new Date('2026-09-07T00:00:00Z'),
    });
    if (!first.ok || first.stage !== 'deleted') throw new Error('第一次就该删掉');

    const second = deleteCase({
      db,
      caseId,
      userId: uid,
      confirmToken: token(),
      now: new Date('2026-09-20T00:00:00Z'),
    });
    if (!second.ok || second.stage !== 'deleted') throw new Error('第二次也该成功');
    expect(second.already_deleted).toBe(true);
    // 首次删除时刻与到期时刻都不许被第二次调用往后推——推了就等于每重试一次多留 30 天
    expect(second.deleted_at).toBe(first.deleted_at);
    expect(second.purge_after).toBe(first.purge_after);
  });

  it('删过之后**不带令牌**再调，回的仍是确认单（令牌稳定，可以照第一步再走一遍）', () => {
    deleteCase({ db, caseId, userId: uid, confirmToken: token() });
    const again = deleteCase({ db, caseId, userId: uid });
    expect(again.ok && again.stage).toBe('confirm');
    // 令牌不因删除而改变：改了的话，一次「没收到回包的重试」会拿到 INVALID_CONFIRM_TOKEN
    expect(again.ok && again.stage === 'confirm' && again.confirm_token).toBe(token());
  });
});
