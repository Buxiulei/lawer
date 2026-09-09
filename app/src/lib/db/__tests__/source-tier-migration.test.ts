// app/src/lib/db/__tests__/source-tier-migration.test.ts
// 来源四档两列的**迁移判据**（设计稿 §4.2-1）。
//
// 【为什么存量回填要单独钉一条】迁移这一步的失败形态不是崩溃：
// 忘了给 DDL 默认值 ⇒ 存量行两列全是 NULL ⇒ 读侧归一不出档位 ⇒ 每一条老事实都渲染成
//「档位读不出」或（更糟）被当成〔未记录〕，而库照常开、应用照常起、没有一处报错。
// 所以这里造一个**没有那两列**的老库，跑一遍迁移，逐列逐行核。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ASSERTED_BY, DEFAULT_SOURCE_TIER } from '@/lib/cases/source-tier';

import { runMigrations } from '../migrate';

/** 这四张表各带哪两列（evidence 上那对说的是**简报结论**，不是文件本身） */
const TIER_COLUMNS: [string, string, string][] = [
  ['timeline_events', 'source_tier', 'asserted_by'],
  ['claims', 'source_tier', 'asserted_by'],
  ['company_profiles', 'source_tier', 'asserted_by'],
  ['evidence', 'brief_source_tier', 'brief_asserted_by'],
];

function columns(db: Database, table: string): { name: string; dflt_value: string | null; notnull: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    dflt_value: string | null;
    notnull: number;
  }[];
}

/** 一个**跑过迁移之后再把两列删掉**的库：等价于上线前那份存量库的形状 */
function legacyDb(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const [table, tier, by] of TIER_COLUMNS) {
    // SQLite 3.35+ 支持 DROP COLUMN；本仓的 better-sqlite3 带的版本满足
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${tier}`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${by}`);
  }
  return db;
}

/** 塞一行存量数据（四张表各一行），返回各自的 id */
function seedLegacyRows(db: Database): Record<string, number> {
  const userId = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run().lastInsertRowid,
  );
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '老案子').lastInsertRowid,
  );
  const fileId = Number(
    db
      .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES ('sha', 1, 'application/pdf', '/x')")
      .run().lastInsertRowid,
  );
  return {
    caseId,
    timeline: Number(
      db
        .prepare("INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, '2026-01-01', '公司动作', '老事件')")
        .run(caseId).lastInsertRowid,
    ),
    claim: Number(
      db.prepare("INSERT INTO claims (case_id, kind) VALUES (?, '2N')").run(caseId).lastInsertRowid,
    ),
    company: Number(
      db.prepare("INSERT INTO company_profiles (case_id, name) VALUES (?, '老公司')").run(caseId).lastInsertRowid,
    ),
    evidence: Number(
      db
        .prepare("INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?, ?, ?, '老材料')")
        .run(caseId, userId, fileId).lastInsertRowid,
    ),
  };
}

describe('来源四档两列的迁移', () => {
  it('四张表各加两列（变异：迁移里漏掉其中一张表 → 红）', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    for (const [table, tier, by] of TIER_COLUMNS) {
      const names = columns(db, table).map((c) => c.name);
      expect(names, `${table}.${tier}`).toContain(tier);
      expect(names, `${table}.${by}`).toContain(by);
    }
  });

  it('DDL 默认值与 source-tier 的缺省逐字相同（变异：把 DDL 里的 \'自述\' 改成别的档 → 红）', () => {
    // 两处各写一个字面量的形态是：改缺省档时只改了其中一处，而两处都返回正常结构。
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    for (const [table, tier, by] of TIER_COLUMNS) {
      const cols = columns(db, table);
      const tierCol = cols.find((c) => c.name === tier)!;
      const byCol = cols.find((c) => c.name === by)!;
      expect(tierCol.dflt_value, `${table}.${tier} 默认值`).toBe(`'${DEFAULT_SOURCE_TIER}'`);
      expect(byCol.dflt_value, `${table}.${by} 默认值`).toBe(`'${DEFAULT_ASSERTED_BY}'`);
      // NOT NULL：允许 NULL 的形态是——读侧归一不出档位，一条老事实被当成〔未记录〕
      expect(tierCol.notnull, `${table}.${tier} NOT NULL`).toBe(1);
      expect(byCol.notnull, `${table}.${by} NOT NULL`).toBe(1);
    }
  });

  it('存量行回填成「自述 / user」，一行不漏（变异：把 DDL 默认值删掉 → 存量行变 NULL → 红）', () => {
    const db = legacyDb();
    const ids = seedLegacyRows(db);
    runMigrations(db); // 第二次跑：这就是上线滚更那一次

    const row = (table: string, id: number) =>
      db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;

    expect(row('timeline_events', ids.timeline)).toMatchObject({ source_tier: '自述', asserted_by: 'user' });
    expect(row('claims', ids.claim)).toMatchObject({ source_tier: '自述', asserted_by: 'user' });
    expect(row('company_profiles', ids.company)).toMatchObject({ source_tier: '自述', asserted_by: 'user' });
    expect(row('evidence', ids.evidence)).toMatchObject({
      brief_source_tier: '自述',
      brief_asserted_by: 'user',
    });
  });

  it('迁移可重跑：连跑三次不报错、行数与列值都不变（变异：把 addColumnIfMissing 换成裸 ALTER → 第二次 duplicate column name）', () => {
    const db = legacyDb();
    const ids = seedLegacyRows(db);
    for (let i = 0; i < 3; i += 1) expect(() => runMigrations(db)).not.toThrow();
    const n = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([n('timeline_events'), n('claims'), n('company_profiles'), n('evidence')]).toEqual([1, 1, 1, 1]);
    expect(
      (db.prepare('SELECT source_tier FROM timeline_events WHERE id = ?').get(ids.timeline) as {
        source_tier: string;
      }).source_tier,
    ).toBe('自述');
  });

  it('迁移不改旧值语义：老行的其余列一个字节没动（变异：迁移里加一句 UPDATE 回填 → 红）', () => {
    const db = legacyDb();
    const ids = seedLegacyRows(db);
    const before = db.prepare('SELECT case_id, happened_at, kind, title FROM timeline_events WHERE id = ?').get(ids.timeline);
    runMigrations(db);
    const after = db.prepare('SELECT case_id, happened_at, kind, title FROM timeline_events WHERE id = ?').get(ids.timeline);
    expect(after).toEqual(before);
  });
});
