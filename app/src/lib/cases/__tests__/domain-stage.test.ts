// stage 校验读的是**案件领域包**，不是某个写死的词表（MCP 设计稿 §13）。
//
// 【变异臂】把 lib/domains/labor.ts 的 stages 改成 []，下面前两条当场红：
// 合法阶段会被判成非法。这证明校验真的在读包，而不是恰好与包内容一致的另一份词表。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { LABOR } from '@/lib/domains/labor';

let db: Database.Database;
let uid: number;
let caseId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '测试案件').lastInsertRowid,
  );
});

describe('stage 校验读领域包', () => {
  it('case_update：领域包里的阶段收得下', () => {
    for (const stage of LABOR.stages) {
      const res = cases.updateCase(db, { caseId, userId: uid, stage });
      expect(res.ok, `${stage} 应当是合法阶段`).toBe(true);
    }
  });

  it('case_update：包外的阶段回 INVALID_STAGE，且错误信息列的就是包里那份', () => {
    const res = cases.updateCase(db, { caseId, userId: uid, stage: '庭外和解' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('INVALID_STAGE');
    expect(res.message).toBe(`stage 只能是 ${LABOR.stages.join(' / ')}`);
  });

  it('intake_submit 走同一份词表', () => {
    const bad = cases.submitIntake(db, {
      caseId,
      userId: uid,
      stage: '庭外和解',
      companyName: '某某公司',
      employedFrom: '2020-01-01',
      monthlyWageFen: 3000000,
      goals: ['要赔偿'],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe('INVALID_STAGE');

    const good = cases.submitIntake(db, {
      caseId,
      userId: uid,
      stage: LABOR.stages[0],
      companyName: '某某公司',
      employedFrom: '2020-01-01',
      monthlyWageFen: 3000000,
      goals: ['要赔偿'],
    });
    expect(good.ok).toBe(true);
  });

  /**
   * 案件的 domain 指向一个不存在的包时**不许回落到某个包**：回落的形态是，
   * 一个 domain 写错的案子被按别的领域的阶段枚举校验，而报错信息看起来完全正常。
   */
  it('domain 认不出来时报 UNKNOWN_DOMAIN，不静默换一个包用', () => {
    db.prepare('UPDATE cases SET domain = ? WHERE id = ?').run('counseling', caseId);
    const res = cases.updateCase(db, { caseId, userId: uid, stage: LABOR.stages[0] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('UNKNOWN_DOMAIN');
    expect(res.message).toContain('counseling');
  });

  it('不改 stage 的更新不受领域包影响（只在校验 stage 时才取包）', () => {
    db.prepare('UPDATE cases SET domain = ? WHERE id = ?').run('counseling', caseId);
    const res = cases.updateCase(db, { caseId, userId: uid, goal: '要 2N' });
    expect(res.ok).toBe(true);
  });
});

describe('回包带 domain', () => {
  it('case_list 每条带 domain，默认是建表默认值', () => {
    const { cases: rows } = cases.listCases(db, { userId: uid });
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe(LABOR.key);
  });

  it('case_get 的档头带 domain', () => {
    const got = cases.getCase(db, { caseId, userId: uid });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.case.domain).toBe(LABOR.key);
  });
});
