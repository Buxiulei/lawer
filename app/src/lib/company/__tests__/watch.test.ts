// app/src/lib/company/__tests__/watch.test.ts
// 一键加守望原语（spec v3 §2.1 M3）：建盯梢、设档、连点去重。
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../../db/migrate';
import { addWatch } from '../watch';

function setup(): { db: Database.Database; caseId: number } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const userId = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('u1').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '案').lastInsertRowid,
  );
  return { db, caseId };
}

const row = (db: Database.Database, id: number) =>
  db.prepare('SELECT name, uscc, status, tier, billing_status, arrears_rounds FROM company_watches WHERE id=?').get(id);

describe('addWatch', () => {
  test('默认进圈1（daily）+ 建档计费默认（free/0）', () => {
    const { db, caseId } = setup();
    const r = addWatch(db, { caseId, name: '某某科技有限公司' });
    expect(r.created).toBe(true);
    expect(row(db, r.id)).toEqual({
      name: '某某科技有限公司',
      uscc: null,
      status: 'active',
      tier: 'daily',
      billing_status: 'free',
      arrears_rounds: 0,
    });
  });

  test('可指定档位与 uscc/关联档', () => {
    const { db, caseId } = setup();
    const profileId = Number(
      db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?,?)').run(caseId, '关联主体').lastInsertRowid,
    );
    const r = addWatch(db, {
      caseId,
      name: '关联主体',
      uscc: '91110105MA00000000',
      companyProfileId: profileId,
      tier: 'weekly',
    });
    expect(r.created).toBe(true);
    const got = db
      .prepare('SELECT tier, uscc, company_profile_id FROM company_watches WHERE id=?')
      .get(r.id);
    expect(got).toEqual({ tier: 'weekly', uscc: '91110105MA00000000', company_profile_id: profileId });
  });

  test('连点去重（同案同名）：第二次返回同一条、不新建、不改档', () => {
    const { db, caseId } = setup();
    const a = addWatch(db, { caseId, name: 'X 公司', tier: 'daily' });
    const b = addWatch(db, { caseId, name: 'X 公司', tier: 'weekly' }); // 就算带了别的档也不改
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect((db.prepare('SELECT COUNT(*) c FROM company_watches WHERE case_id=?').get(caseId) as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT tier t FROM company_watches WHERE id=?').get(a.id) as { t: string }).t).toBe('daily');
  });

  test('去重按最具体标识：给了关联档 id 就按 (case, profile) 去重', () => {
    const { db, caseId } = setup();
    const profileId = Number(
      db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?,?)').run(caseId, 'P').lastInsertRowid,
    );
    const a = addWatch(db, { caseId, name: '母公司', companyProfileId: profileId });
    const b = addWatch(db, { caseId, name: '母公司（改了个显示名）', companyProfileId: profileId });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  test('已暂停的同名盯梢不参与去重：可另建一条活跃的', () => {
    const { db, caseId } = setup();
    const a = addWatch(db, { caseId, name: 'Y 公司' });
    db.prepare("UPDATE company_watches SET status='paused' WHERE id=?").run(a.id);
    const b = addWatch(db, { caseId, name: 'Y 公司' });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  test('未知档报错，不静默落一个不会计费的档', () => {
    const { db, caseId } = setup();
    // @ts-expect-error 故意传非法档位
    expect(() => addWatch(db, { caseId, name: 'Z', tier: '圈4' })).toThrow(/未知守望档/);
  });
});
